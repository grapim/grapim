// Platforms and their API keys (docs/platform.md, "Concepts").
//
// - A platform is a team with kind = 'platform'. Only an owner turns a team
//   into one, and while HUB_TEAM_CREATORS is set only those accounts can.
// - Keys are gpk_live_... or gpk_test_..., 256-bit, shown once, stored as
//   sha256 with the last 4 characters as a hint, revocable, last_used_at.
//   Only an owner creates or revokes them, in the hub UI. A key acts for the
//   whole platform, as the owner who made it; it stops working when that
//   person leaves the team or stops being an owner, or the team stops being
//   a platform.

import { tx } from '../db.js';
import { HttpError } from '../http.js';
import { randomId, randomToken, same, sha256 } from '../secure.js';

export const KEY_PREFIX = { live: 'gpk_live_', test: 'gpk_test_' };
export const MODES = ['live', 'test'];
export const DEFAULT_WORKSPACE_STORAGE_MB = 512;
const KEY_NAME_RE = /^[A-Za-z0-9._-]{1,40}$/;
const MAX_KEYS = 20; // live keys per platform

export class PlatformKeys {
  constructor({ db, now, config }) {
    this.db = db;
    this.now = now;
    this.config = config;
  }

  // ---- Platforms ----

  // May this user turn teams into platforms? HUB_PLATFORM_CREATORS, else the
  // team creation allowlist.
  mayEnable(user) {
    const c = this.config.platformCreators ?? this.config.teamCreators;
    return !c || c.includes(String(user.id)) || c.includes(String(user.login).toLowerCase());
  }

  enable(team, user) {
    if (!this.mayEnable(user)) {
      throw new HttpError(403, 'forbidden', 'Platforms are in a closed beta on this hub: only invited accounts can turn a team into a platform.');
    }
    tx(this.db, () => {
      this.db.prepare("UPDATE teams SET kind = 'platform' WHERE id = ?").run(team.id);
      this.db.prepare('INSERT OR IGNORE INTO platforms (team_id, created_by, created_at) VALUES (?, ?, ?)').run(team.id, user.id, this.now());
      for (const mode of MODES) this.db.prepare('INSERT OR IGNORE INTO platform_settings (team_id, mode) VALUES (?, ?)').run(team.id, mode);
    });
  }

  // Settings belong to one mode (review M6): a test key reads and writes only
  // the test settings, a live key and the hub page's live form the live ones.
  settings(teamId, mode = 'live') {
    const row = this.db.prepare('SELECT embed_allowed_origins, workspace_storage_mb FROM platform_settings WHERE team_id = ? AND mode = ?').get(teamId, mode === 'test' ? 'test' : 'live');
    let origins = [];
    try {
      origins = JSON.parse(row?.embed_allowed_origins ?? '[]');
    } catch {}
    return { embed_allowed_origins: Array.isArray(origins) ? origins : [], workspace_storage_mb: row?.workspace_storage_mb ?? DEFAULT_WORKSPACE_STORAGE_MB };
  }

  // patch: { embed_allowed_origins?, workspace_storage_mb? }, already checked.
  setSettings(teamId, mode, patch) {
    const m = mode === 'test' ? 'test' : 'live';
    tx(this.db, () => {
      this.db.prepare('INSERT OR IGNORE INTO platform_settings (team_id, mode) VALUES (?, ?)').run(teamId, m);
      if (patch.embed_allowed_origins !== undefined) {
        this.db.prepare('UPDATE platform_settings SET embed_allowed_origins = ? WHERE team_id = ? AND mode = ?').run(JSON.stringify(patch.embed_allowed_origins), teamId, m);
      }
      if (patch.workspace_storage_mb !== undefined) {
        this.db.prepare('UPDATE platform_settings SET workspace_storage_mb = ? WHERE team_id = ? AND mode = ?').run(patch.workspace_storage_mb, teamId, m);
      }
    });
  }

  setOrigins(teamId, mode, origins) {
    this.setSettings(teamId, mode, { embed_allowed_origins: origins });
  }

  // ---- Keys ----

  create(teamId, actor, rawName, rawMode) {
    const mode = rawMode === 'test' ? 'test' : rawMode === 'live' ? 'live' : null;
    if (!mode) throw new HttpError(400, 'bad_request', 'Pick live or test.');
    const name = String(rawName ?? '').trim();
    if (!KEY_NAME_RE.test(name)) throw new HttpError(400, 'bad_request', 'Name the key with 1 to 40 letters, digits, dots, dashes or underscores.');
    const key = KEY_PREFIX[mode] + randomToken(32);
    const id = randomId(9);
    tx(this.db, () => {
      const live = this.db.prepare('SELECT COUNT(*) AS n FROM platform_keys WHERE team_id = ? AND revoked_at IS NULL').get(teamId).n;
      if (live >= MAX_KEYS) throw new HttpError(409, 'conflict', `This platform has ${MAX_KEYS} live keys. Revoke some first.`);
      this.db
        .prepare('INSERT INTO platform_keys (id, team_id, mode, name, key_hash, hint, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, teamId, mode, name, sha256(key), key.slice(-4), actor.userId, this.now());
    });
    return { id, name, mode, key };
  }

  list(teamId) {
    return this.db
      .prepare(
        `SELECT k.id, k.name, k.mode, k.hint, k.created_at, k.last_used_at, u.login AS owner
         FROM platform_keys k LEFT JOIN users u ON u.id = k.created_by
         WHERE k.team_id = ? AND k.revoked_at IS NULL ORDER BY k.created_at DESC`,
      )
      .all(teamId);
  }

  revoke(teamId, keyId) {
    const r = this.db.prepare('UPDATE platform_keys SET revoked_at = ? WHERE id = ? AND team_id = ? AND revoked_at IS NULL').run(this.now(), String(keyId), teamId);
    if (!r.changes) throw new HttpError(404, 'not_found', 'No such key.');
  }

  // { key, team, mode } for a live key of a platform whose creator is still
  // in the team, else null.
  authenticate(raw) {
    if (typeof raw !== 'string' || raw.length > 120 || !(raw.startsWith(KEY_PREFIX.live) || raw.startsWith(KEY_PREFIX.test))) return null;
    const hash = sha256(raw);
    const row = this.db.prepare('SELECT * FROM platform_keys WHERE key_hash = ?').get(hash);
    if (!row || !same(row.key_hash, hash) || row.revoked_at) return null;
    if (!raw.startsWith(KEY_PREFIX[row.mode])) return null;
    const team = this.db.prepare('SELECT * FROM teams WHERE id = ?').get(row.team_id);
    if (!team || team.kind !== 'platform') return null;
    // The key acts as an owner (it deletes workspaces, mints tokens), so it
    // works only while its creator still is one: a demoted owner's keys stop
    // with their role, not only when they leave (review M2).
    if (!this.db.prepare("SELECT 1 FROM members WHERE team_id = ? AND user_id = ? AND role = 'owner'").get(row.team_id, row.created_by)) return null;
    const t = this.now();
    if (!row.last_used_at || t - row.last_used_at > 60_000) this.db.prepare('UPDATE platform_keys SET last_used_at = ? WHERE id = ?').run(t, row.id);
    return { key: row, team, mode: row.mode };
  }
}

// Per-key token buckets, in memory: `burst` requests at once, refilled at
// `rate` per second. Bounded like the hub's limiter.
export class KeyLimiter {
  constructor({ now, burst = 50, rate = 20, maxKeys = 10_000 }) {
    this.now = now;
    this.burst = burst;
    this.rate = rate;
    this.maxKeys = maxKeys;
    this.buckets = new Map();
  }

  // true if allowed; else the seconds to wait.
  take(key) {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.buckets.delete(this.buckets.keys().next().value);
      b = { tokens: this.burst, at: t };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(this.burst, b.tokens + ((t - b.at) / 1000) * this.rate);
    b.at = t;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return true;
    }
    return Math.max(1, Math.ceil((1 - b.tokens) / this.rate));
  }
}
