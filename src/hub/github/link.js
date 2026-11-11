// Installations, and linking one to a team.
//
// Only a team owner links, from the team's GitHub page:
// - "Install" hands GitHub a state: HMAC-signed with HUB_SECRET (purpose
//   "github-install"), naming the team and the owner, expiring after 30
//   minutes, single use (its nonce is stored hashed and deleted on use).
//   The setup callback accepts it only from the same signed-in person.
// - The installation id GitHub sends back is not trusted by itself (anyone
//   can type one into the URL). It is linked only if the hub saw its
//   installation.created event with that person as the sender, or if GitHub,
//   asked with the App JWT, says it is installed on that person's own account.
//   Otherwise the link waits (1 hour) for the installation.created event, and
//   completes only if its sender is that person.
// - An installation linked to one team cannot be linked to another; unlinking
//   is per team. Events of unlinked installations are ignored.

import { tx } from '../db.js';
import { HttpError } from '../http.js';
import { randomToken, sha256, sign, unsign } from '../secure.js';

export const STATE_MS = 30 * 60 * 1000;
export const PENDING_MS = 60 * 60 * 1000;
const PURPOSE = 'github-install';

const int = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);

export class Installations {
  constructor({ db, now, secret, teams }) {
    this.db = db;
    this.now = now;
    this.secret = secret;
    this.teams = teams;
  }

  get(id) {
    return this.db.prepare('SELECT * FROM gh_installations WHERE id = ?').get(Number(id)) ?? null;
  }

  // ---- From webhooks and the App API ----

  upsert(installation, sender = null) {
    const id = int(installation?.id);
    if (!id) return null;
    const acc = installation.account ?? {};
    const t = this.now();
    this.db
      .prepare(
        `INSERT INTO gh_installations (id, account_id, account_login, account_type, sender_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET account_id = excluded.account_id, account_login = excluded.account_login,
           account_type = excluded.account_type, sender_id = COALESCE(gh_installations.sender_id, excluded.sender_id),
           updated_at = excluded.updated_at`,
      )
      // Only a real 'User' account may be linked by its own id (mayLink): an
      // Enterprise account's id is not a user id.
      .run(id, int(acc.id), typeof acc.login === 'string' ? acc.login.slice(0, 100) : null, acc.type === 'Organization' || acc.type === 'User' ? acc.type : 'Other', int(sender?.id), t, t);
    return this.get(id);
  }

  created(installation, sender) {
    let row = this.upsert(installation, sender);
    if (!row) return null;
    if (row.deleted_at) {
      this.db.prepare('UPDATE gh_installations SET deleted_at = NULL WHERE id = ?').run(row.id);
      row = this.get(row.id);
    }
    // A setup callback that arrived before this event: finish it now if the
    // person who started it is the one who installed.
    const pending = this.db.prepare('SELECT * FROM gh_pending_links WHERE installation_id = ?').get(row.id);
    if (pending) {
      this.db.prepare('DELETE FROM gh_pending_links WHERE installation_id = ?').run(row.id);
      const owner = this.teams.membership(pending.team_id, pending.user_id)?.role === 'owner';
      if (pending.expires_at > this.now() && owner && row.sender_id === pending.user_id && !row.team_id) {
        this.#setTeam(row.id, pending.team_id, pending.user_id);
      }
    }
    return this.get(row.id);
  }

  deleted(installation) {
    const id = int(installation?.id);
    if (!id) return;
    this.db.prepare('UPDATE gh_installations SET deleted_at = ?, team_id = NULL, updated_at = ? WHERE id = ?').run(this.now(), this.now(), id);
    this.db.prepare('DELETE FROM gh_installation_repos WHERE installation_id = ?').run(id);
    this.db.prepare('DELETE FROM gh_pending_links WHERE installation_id = ?').run(id);
  }

  suspended(installation, on) {
    const id = int(installation?.id);
    if (id) this.db.prepare('UPDATE gh_installations SET suspended_at = ?, updated_at = ? WHERE id = ?').run(on ? this.now() : null, this.now(), id);
  }

  repos(installationId, added = [], removed = []) {
    const id = int(installationId);
    if (!id) return;
    tx(this.db, () => {
      for (const r of removed.slice(0, 5000)) if (int(r?.id)) this.db.prepare('DELETE FROM gh_installation_repos WHERE installation_id = ? AND repo_id = ?').run(id, r.id);
      for (const r of added.slice(0, 5000)) {
        if (int(r?.id) && typeof r.full_name === 'string' && r.full_name.length <= 200) {
          this.db.prepare('INSERT OR REPLACE INTO gh_installation_repos (installation_id, repo_id, full_name) VALUES (?, ?, ?)').run(id, r.id, r.full_name);
        }
      }
    });
  }

  // ---- The linking state ----

  issueState(teamId, userId) {
    const nonce = randomToken(24);
    const exp = this.now() + STATE_MS;
    this.db.prepare('INSERT INTO gh_link_states (nonce_hash, team_id, user_id, expires_at) VALUES (?, ?, ?, ?)').run(sha256(nonce), teamId, userId, exp);
    const payload = Buffer.from(JSON.stringify({ t: teamId, u: userId, n: nonce, e: exp })).toString('base64url');
    return sign(this.secret, PURPOSE, payload);
  }

  // The team a state was issued for, if it is genuine, unexpired, unused and
  // was issued to `userId`. Consumed either way.
  consumeState(state, userId) {
    const bad = () => new HttpError(400, 'bad_state', 'This GitHub link expired or did not start here. Start again from your team settings.');
    if (typeof state !== 'string' || state.length > 1000) throw bad();
    const payload = unsign(this.secret, PURPOSE, state);
    if (!payload) throw bad();
    let s;
    try {
      s = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      throw bad();
    }
    if (typeof s?.n !== 'string' || typeof s.t !== 'string') throw bad();
    const row = tx(this.db, () => {
      const r = this.db.prepare('SELECT * FROM gh_link_states WHERE nonce_hash = ?').get(sha256(s.n));
      if (r) this.db.prepare('DELETE FROM gh_link_states WHERE nonce_hash = ?').run(r.nonce_hash);
      return r;
    });
    if (!row || row.expires_at <= this.now() || !(s.e > this.now()) || row.team_id !== s.t || row.user_id !== s.u || s.u !== userId) throw bad();
    return { teamId: row.team_id };
  }

  sweep() {
    this.db.prepare('DELETE FROM gh_link_states WHERE expires_at <= ?').run(this.now());
    this.db.prepare('DELETE FROM gh_pending_links WHERE expires_at <= ?').run(this.now());
  }

  // ---- Linking ----

  // True if `userId` (a GitHub user id: hub users are keyed by it) installed
  // this installation, or it is installed on that user's own account.
  mayLink(row, userId) {
    if (!row || row.deleted_at) return false;
    return row.sender_id === userId || (row.account_type === 'User' && row.account_id === userId);
  }

  #setTeam(id, teamId, userId) {
    this.db.prepare('UPDATE gh_installations SET team_id = ?, linked_by = ?, linked_at = ?, updated_at = ? WHERE id = ?').run(teamId, userId, this.now(), this.now(), id);
  }

  // Links (or refuses). -> 'linked' | 'already'
  link(teamId, installationId, userId) {
    return tx(this.db, () => {
      const row = this.get(installationId);
      if (!row || row.deleted_at || !this.mayLink(row, userId)) {
        throw new HttpError(404, 'not_found', 'That installation is not available to link. Only the GitHub user who installed the App can link it.');
      }
      if (row.team_id === teamId) return 'already';
      if (row.team_id) throw new HttpError(409, 'conflict', 'That installation is linked to another team. Unlink it there first.');
      this.#setTeam(row.id, teamId, userId);
      return 'linked';
    });
  }

  // The first live pending link wins: anyone with a state of their own can
  // name any installation id here, and replacing the installer's pending
  // link would quietly stop it from completing. The same person may renew theirs.
  pend(teamId, installationId, userId) {
    this.db
      .prepare(
        `INSERT INTO gh_pending_links (installation_id, team_id, user_id, expires_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(installation_id) DO UPDATE SET team_id = excluded.team_id, user_id = excluded.user_id, expires_at = excluded.expires_at
         WHERE gh_pending_links.user_id = excluded.user_id OR gh_pending_links.expires_at <= ?`,
      )
      .run(Number(installationId), teamId, userId, this.now() + PENDING_MS, this.now());
  }

  unlink(teamId, installationId) {
    const r = this.db.prepare('UPDATE gh_installations SET team_id = NULL, linked_by = NULL, linked_at = NULL, updated_at = ? WHERE id = ? AND team_id = ?').run(this.now(), Number(installationId), teamId);
    if (!r.changes) throw new HttpError(404, 'not_found', 'No such installation in this team.');
  }

  // For the team page: the team's installations, and the unlinked ones this person may link.
  forTeam(teamId) {
    return this.db
      .prepare(
        `SELECT i.*, u.login AS linked_by_login, (SELECT COUNT(*) FROM gh_installation_repos r WHERE r.installation_id = i.id) AS repos
         FROM gh_installations i LEFT JOIN users u ON u.id = i.linked_by WHERE i.team_id = ? AND i.deleted_at IS NULL ORDER BY i.account_login`,
      )
      .all(teamId);
  }

  linkableBy(userId) {
    return this.db
      .prepare(
        `SELECT * FROM gh_installations WHERE team_id IS NULL AND deleted_at IS NULL
           AND (sender_id = ? OR (account_type = 'User' AND account_id = ?)) ORDER BY account_login`,
      )
      .all(userId, userId);
  }

  pendingFor(teamId) {
    return this.db.prepare('SELECT * FROM gh_pending_links WHERE team_id = ? AND expires_at > ?').all(teamId, this.now());
  }
}
