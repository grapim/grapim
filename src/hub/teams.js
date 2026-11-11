// Teams, members, invites and machine tokens: the data rules, without HTTP.
//
// - Invite tokens and machine tokens are 256-bit random values shown once and
//   stored only as sha256. An invite is single use and expires after 7 days.
// - Leaving or being removed revokes that person's machine tokens for the team.
// - Owners invite, remove members and manage billing. Any member can create
//   machine tokens for themselves and see the team's repos.

import { tx } from './db.js';
import { HttpError } from './http.js';
import { randomId, randomToken, same, sha256 } from './secure.js';

export const INVITE_DAYS = 7;
const INVITE_MS = INVITE_DAYS * 24 * 60 * 60 * 1000;
export const TOKEN_PREFIX = 'cmh_';

const cleanName = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);

export class Teams {
  constructor({ db, now, limits }) {
    this.db = db;
    this.now = now;
    this.limits = limits; // (team) -> { seats, historyDays, repos }
  }

  // ---- Teams ----

  create(user, name) {
    const n = cleanName(name, 80);
    if (!n) throw new HttpError(400, 'bad_request', 'Give the team a name.');
    const owned = this.db.prepare("SELECT COUNT(*) AS n FROM members WHERE user_id = ? AND role = 'owner'").get(user.id).n;
    if (owned >= 20) throw new HttpError(409, 'conflict', 'You already own 20 teams.');
    const id = randomId(9);
    const t = this.now();
    tx(this.db, () => {
      this.db.prepare('INSERT INTO teams (id, name, created_by, created_at) VALUES (?, ?, ?, ?)').run(id, n, user.id, t);
      this.db.prepare("INSERT INTO members (team_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").run(id, user.id, t);
    });
    return this.get(id);
  }

  get(teamId) {
    return this.db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId) ?? null;
  }

  forUser(userId) {
    return this.db
      .prepare(
        `SELECT t.id, t.name, t.plan, m.role,
                (SELECT COUNT(*) FROM members x WHERE x.team_id = t.id) AS members,
                (SELECT COUNT(*) FROM repos r WHERE r.team_id = t.id) AS repos
         FROM members m JOIN teams t ON t.id = m.team_id WHERE m.user_id = ? ORDER BY t.name COLLATE NOCASE`,
      )
      .all(userId);
  }

  // { team, role } if the user belongs to the team, else null.
  membership(teamId, userId) {
    if (typeof teamId !== 'string' || !/^[A-Za-z0-9_-]{6,40}$/.test(teamId)) return null;
    const row = this.db.prepare('SELECT role FROM members WHERE team_id = ? AND user_id = ?').get(teamId, userId);
    if (!row) return null;
    return { team: this.get(teamId), role: row.role };
  }

  members(teamId) {
    return this.db
      .prepare(
        `SELECT u.id, u.login, u.name, u.avatar_url, m.role, m.created_at AS joined_at
         FROM members m JOIN users u ON u.id = m.user_id WHERE m.team_id = ? ORDER BY m.role = 'owner' DESC, u.login COLLATE NOCASE`,
      )
      .all(teamId);
  }

  seatsUsed(teamId) {
    return this.db.prepare('SELECT COUNT(*) AS n FROM members WHERE team_id = ?').get(teamId).n;
  }

  #revokeTokensOf(teamId, userId) {
    this.db.prepare('UPDATE machine_tokens SET revoked_at = ? WHERE team_id = ? AND user_id = ? AND revoked_at IS NULL').run(this.now(), teamId, userId);
  }

  removeMember(teamId, actor, userId) {
    if (actor.role !== 'owner') throw new HttpError(403, 'forbidden', 'Only an owner can remove members.');
    if (userId === actor.userId) throw new HttpError(400, 'bad_request', 'To remove yourself, leave the team.');
    tx(this.db, () => {
      const r = this.db.prepare('DELETE FROM members WHERE team_id = ? AND user_id = ?').run(teamId, userId);
      if (!r.changes) throw new HttpError(404, 'not_found', 'That person is not in this team.');
      this.#revokeTokensOf(teamId, userId);
    });
  }

  leave(teamId, userId) {
    tx(this.db, () => {
      const me = this.db.prepare('SELECT role FROM members WHERE team_id = ? AND user_id = ?').get(teamId, userId);
      if (!me) throw new HttpError(404, 'not_found', 'Not found.');
      if (me.role === 'owner') {
        const owners = this.db.prepare("SELECT COUNT(*) AS n FROM members WHERE team_id = ? AND role = 'owner'").get(teamId).n;
        if (owners <= 1) throw new HttpError(409, 'conflict', 'You are the only owner. A team needs an owner, so it cannot be left in v0.');
      }
      this.db.prepare('DELETE FROM members WHERE team_id = ? AND user_id = ?').run(teamId, userId);
      this.#revokeTokensOf(teamId, userId);
    });
  }

  // ---- Invites ----

  createInvite(teamId, actor) {
    if (actor.role !== 'owner') throw new HttpError(403, 'forbidden', 'Only an owner can invite.');
    const pending = this.db
      .prepare('SELECT COUNT(*) AS n FROM invites WHERE team_id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?')
      .get(teamId, this.now()).n;
    if (pending >= 50) throw new HttpError(409, 'conflict', 'This team has 50 open invites. Revoke some first.');
    const token = randomToken(32);
    const id = randomId(9);
    const t = this.now();
    this.db
      .prepare('INSERT INTO invites (id, team_id, token_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, teamId, sha256(token), actor.userId, t, t + INVITE_MS);
    return { id, token, expires_at: t + INVITE_MS };
  }

  invites(teamId) {
    return this.db
      .prepare(
        `SELECT i.id, i.created_at, i.expires_at, u.login AS created_by
         FROM invites i LEFT JOIN users u ON u.id = i.created_by
         WHERE i.team_id = ? AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ?
         ORDER BY i.created_at DESC`,
      )
      .all(teamId, this.now());
  }

  revokeInvite(teamId, actor, inviteId) {
    if (actor.role !== 'owner') throw new HttpError(403, 'forbidden', 'Only an owner can revoke invites.');
    const r = this.db
      .prepare('UPDATE invites SET revoked_at = ? WHERE id = ? AND team_id = ? AND used_at IS NULL AND revoked_at IS NULL')
      .run(this.now(), String(inviteId), teamId);
    if (!r.changes) throw new HttpError(404, 'not_found', 'No such open invite.');
  }

  #openInvite(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
    const hash = sha256(token);
    const row = this.db.prepare('SELECT * FROM invites WHERE token_hash = ?').get(hash);
    if (!row || !same(row.token_hash, hash)) return null;
    if (row.used_at || row.revoked_at || row.expires_at <= this.now()) return null;
    return row;
  }

  // For the accept page: the team an open invite is for, or null.
  peekInvite(token) {
    const row = this.#openInvite(token);
    if (!row) return null;
    const team = this.get(row.team_id);
    return team ? { team: { id: team.id, name: team.name }, expires_at: row.expires_at } : null;
  }

  acceptInvite(token, userId) {
    return tx(this.db, () => {
      const row = this.#openInvite(token);
      if (!row) throw new HttpError(410, 'invite_invalid', 'This invite link has expired, was already used, or was revoked. Ask for a new one.');
      const team = this.get(row.team_id);
      if (this.db.prepare('SELECT 1 FROM members WHERE team_id = ? AND user_id = ?').get(row.team_id, userId)) {
        return { team, already: true };
      }
      const { seats } = this.limits(team);
      if (this.seatsUsed(team.id) >= seats) {
        throw new HttpError(402, 'seat_limit', `${team.name} has used all ${seats} seats. An owner can add seats in billing.`);
      }
      const used = this.db.prepare('UPDATE invites SET used_at = ?, used_by = ? WHERE id = ? AND used_at IS NULL').run(this.now(), userId, row.id);
      if (!used.changes) throw new HttpError(410, 'invite_invalid', 'This invite link was already used.');
      this.db.prepare("INSERT INTO members (team_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)").run(team.id, userId, this.now());
      return { team, already: false };
    });
  }

  // ---- Machine tokens ----

  createToken(teamId, actor, name) {
    const n = cleanName(name, 60) || 'machine';
    const live = this.db.prepare('SELECT COUNT(*) AS n FROM machine_tokens WHERE team_id = ? AND user_id = ? AND revoked_at IS NULL').get(teamId, actor.userId).n;
    if (live >= 25) throw new HttpError(409, 'conflict', 'You have 25 live tokens in this team. Revoke some first.');
    const token = TOKEN_PREFIX + randomToken(32);
    const id = randomId(9);
    this.db
      .prepare('INSERT INTO machine_tokens (id, team_id, user_id, name, token_hash, hint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, teamId, actor.userId, n, sha256(token), token.slice(-4), this.now());
    return { id, name: n, token };
  }

  // Owners see every token in the team; members see their own.
  tokens(teamId, actor) {
    const rows = this.db
      .prepare(
        `SELECT t.id, t.name, t.hint, t.created_at, t.last_used_at, t.revoked_at, t.user_id, u.login AS owner
         FROM machine_tokens t LEFT JOIN users u ON u.id = t.user_id
         WHERE t.team_id = ? AND t.revoked_at IS NULL ORDER BY t.created_at DESC`,
      )
      .all(teamId);
    return rows.filter((r) => actor.role === 'owner' || r.user_id === actor.userId);
  }

  revokeToken(teamId, actor, tokenId) {
    const row = this.db.prepare('SELECT user_id FROM machine_tokens WHERE id = ? AND team_id = ? AND revoked_at IS NULL').get(String(tokenId), teamId);
    if (!row || (actor.role !== 'owner' && row.user_id !== actor.userId)) throw new HttpError(404, 'not_found', 'No such token.');
    this.db.prepare('UPDATE machine_tokens SET revoked_at = ? WHERE id = ? AND team_id = ?').run(this.now(), String(tokenId), teamId);
  }

  // The token row and team for a bearer token, or null. The token's creator
  // must still be in the team.
  authenticate(raw) {
    if (typeof raw !== 'string' || !raw.startsWith(TOKEN_PREFIX) || raw.length > 100) return null;
    const hash = sha256(raw);
    const row = this.db.prepare('SELECT * FROM machine_tokens WHERE token_hash = ?').get(hash);
    if (!row || !same(row.token_hash, hash) || row.revoked_at) return null;
    if (!this.db.prepare('SELECT 1 FROM members WHERE team_id = ? AND user_id = ?').get(row.team_id, row.user_id)) return null;
    const t = this.now();
    if (!row.last_used_at || t - row.last_used_at > 60_000) {
      this.db.prepare('UPDATE machine_tokens SET last_used_at = ? WHERE id = ?').run(t, row.id);
    }
    return { token: row, team: this.get(row.team_id) };
  }

  // ---- Billing state (called by the billing module's webhook handler) ----

  // A null field means "this event does not say": keep what is stored. Plan,
  // seats and status only move forward in event time, so a late, older Stripe
  // event cannot undo a newer one; ids and period end only fill in.
  // `meta.eventId` (the Stripe event id) makes a redelivered or replayed event
  // a no-op. Two events with the same timestamp cannot revive a canceled plan.
  setPlan(teamId, p = {}, meta = {}) {
    if (typeof teamId !== 'string') return false;
    const str = (v, max = 200) => (typeof v === 'string' && v.length <= max ? v : null);
    const int = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
    return tx(this.db, () => {
      const team = this.get(teamId);
      if (!team) return false;
      const eventId = str(meta?.eventId);
      if (eventId) {
        const ins = this.db.prepare('INSERT OR IGNORE INTO billing_events (event_id, team_id, applied_at) VALUES (?, ?, ?)').run(eventId, teamId, this.now());
        if (!ins.changes) return true;
      }
      const at = int(p.eventAt) ?? this.now();
      const fresh =
        !team.billing_event_at || at > team.billing_event_at || (at === team.billing_event_at && (team.plan_status !== 'canceled' || p.status === 'canceled'));
      this.db
        .prepare(
          `UPDATE teams SET customer_id = COALESCE(?, customer_id), subscription_id = COALESCE(?, subscription_id),
             period_end = COALESCE(?, period_end) WHERE id = ?`,
        )
        .run(str(p.customerId), str(p.subscriptionId), int(p.periodEnd), teamId);
      if (fresh) {
        this.db
          .prepare(
            `UPDATE teams SET plan = COALESCE(?, plan), seats = COALESCE(?, seats), plan_status = COALESCE(?, plan_status),
               past_due_since = CASE WHEN ? IN ('active', 'trialing', 'canceled') THEN NULL ELSE COALESCE(?, past_due_since) END,
               billing_event_at = ? WHERE id = ?`,
          )
          .run(str(p.plan, 40), int(p.seats), str(p.status, 40), str(p.status, 40), int(p.pastDueSince), at, teamId);
      }
      return true;
    });
  }

  // For Stripe events that name only the customer or subscription.
  teamIdForBilling({ customerId, subscriptionId } = {}) {
    const row =
      (subscriptionId && this.db.prepare('SELECT id FROM teams WHERE subscription_id = ?').get(String(subscriptionId))) ||
      (customerId && this.db.prepare('SELECT id FROM teams WHERE customer_id = ?').get(String(customerId)));
    return row?.id ?? null;
  }
}
