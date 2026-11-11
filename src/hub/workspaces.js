// Cloud workspaces: the data rules and the folders, without HTTP.
// docs/workspaces.md section 1.
//
// - A workspace is a git repo at HUB_DATA/workspaces/<team_id>/<id>/, made
//   with `git init` and one empty commit by Grapim <workspace@grapim.local>.
//   Its Grapim state lives in .git/grapim/ as in any repo.
// - Its URL is /w/<team_id>/<name>/. Names are lowercase slugs, unique among
//   the team's live workspaces; renaming changes the URL, never the folder.
// - Deleting is soft: the folder moves to HUB_DATA/trash/<team_id>/ and the
//   row keeps deleted_at, so every URL and token of it stops working. Purging
//   the trash is v1; until then its bytes still count toward the team quota.
// - Workspace tokens (gws_...) are 256-bit, stored as sha256, shown once,
//   scoped to one workspace and to read or write. Their name is the agent
//   namespace (http:<token-name>/<X-Grapim-Agent>), so it is unique in the
//   workspace for good and may not hold "/" or "@".

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { tx } from './db.js';
import { HttpError } from './http.js';
import { randomId, randomToken, same, sha256 } from './secure.js';

export const WS_TOKEN_PREFIX = 'gws_';
export const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
export const TEAM_ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
const TOKEN_NAME_RE = /^[A-Za-z0-9._-]{1,40}$/;
const MAX_TOKENS = 50; // live tokens per workspace
const MAX_WORKSPACES = 1000; // per team, whatever the plan says: one team cannot fill the disk with folders
const MAX_PLATFORM_WORKSPACES = 100_000; // a platform has one per end customer; the storage quota still binds

export const GIT_IDENTITY = ['-c', 'user.name=Grapim', '-c', 'user.email=workspace@grapim.local'];

const nameError = () =>
  new HttpError(400, 'bad_request', 'Use 1 to 40 lowercase letters, digits and dashes for the name, starting and ending with a letter or digit (it becomes part of the URL).');

export function cleanWorkspaceName(raw) {
  const n = String(raw ?? '').trim().toLowerCase();
  if (!NAME_RE.test(n)) throw nameError();
  return n;
}

// `git init` plus an empty first commit by the fixed workspace identity. No
// hook samples (--template=), and nothing from the hub's own git config can
// sign, hook or rename the branch.
export function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const git = (args) =>
    execFileSync('git', args, {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: 30_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  git(['-c', 'init.defaultBranch=main', 'init', '--quiet', '--template=']);
  git([...GIT_IDENTITY, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', 'commit', '--quiet', '--allow-empty', '--no-verify', '-m', 'Workspace created']);
}

export class Workspaces {
  constructor({ db, now, limits, dataDir }) {
    this.db = db;
    this.now = now;
    this.limits = limits;
    this.root = path.join(dataDir, 'workspaces');
    this.trash = path.join(dataDir, 'trash');
  }

  dirOf(ws) {
    return path.join(this.root, ws.team_id, ws.id);
  }

  // The key its files are stored under in the storage backend.
  storageKey(ws) {
    return `${ws.team_id}/${ws.id}`;
  }

  limitOf(team) {
    const n = this.limits(team).workspaces;
    return Number.isFinite(n) || n === Infinity ? n : 1;
  }

  // ---- Workspaces ----

  live(teamId) {
    return this.db.prepare('SELECT * FROM workspaces WHERE team_id = ? AND deleted_at IS NULL ORDER BY name').all(teamId);
  }

  count(teamId) {
    return this.db.prepare('SELECT COUNT(*) AS n FROM workspaces WHERE team_id = ? AND deleted_at IS NULL').get(teamId).n;
  }

  // A live workspace of the team by id (hub pages) or by name (the /w/ URLs).
  byId(teamId, id) {
    if (typeof id !== 'string' || !TEAM_ID_RE.test(id)) return null;
    return this.db.prepare('SELECT * FROM workspaces WHERE id = ? AND team_id = ? AND deleted_at IS NULL').get(id, teamId) ?? null;
  }

  byName(teamId, name) {
    if (typeof name !== 'string' || !NAME_RE.test(name)) return null;
    return this.db.prepare('SELECT * FROM workspaces WHERE team_id = ? AND name = ? AND deleted_at IS NULL').get(teamId, name) ?? null;
  }

  all() {
    return this.db.prepare('SELECT * FROM workspaces WHERE deleted_at IS NULL').all();
  }

  // extra (the platform API, src/hub/platform/): { externalId, metadata
  // (JSON text), mode ('test' or null), check() run inside the transaction }.
  create(team, actor, rawName, extra = {}) {
    const name = cleanWorkspaceName(rawName);
    const id = randomId(9);
    const t = this.now();
    const ws = tx(this.db, () => {
      const n = this.count(team.id);
      const limit = this.limitOf(team);
      if (n >= limit) {
        throw new HttpError(402, 'plan_limit', `The ${team.plan} plan includes ${limit} workspace${limit === 1 ? '' : 's'}. Delete one, or upgrade the team.`);
      }
      const cap = team.kind === 'platform' ? MAX_PLATFORM_WORKSPACES : MAX_WORKSPACES;
      if (n >= cap) throw new HttpError(409, 'conflict', `A team can have at most ${cap} workspaces.`);
      if (this.byName(team.id, name)) throw new HttpError(409, 'conflict', `This team already has a workspace named ${name}.`);
      extra.check?.();
      this.db
        .prepare('INSERT INTO workspaces (id, team_id, name, created_by, created_at, external_id, metadata, mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, team.id, name, actor.userId, t, extra.externalId ?? null, extra.metadata ?? null, extra.mode ?? null);
      return this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id);
    });
    try {
      initRepo(this.dirOf(ws));
    } catch (err) {
      this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
      fs.rmSync(this.dirOf(ws), { recursive: true, force: true });
      throw new Error(`could not create the workspace repo: ${err.message}`);
    }
    return ws;
  }

  rename(teamId, id, rawName) {
    const name = cleanWorkspaceName(rawName);
    return tx(this.db, () => {
      const ws = this.byId(teamId, id);
      if (!ws) throw new HttpError(404, 'not_found', 'Not found.');
      if (ws.name === name) return ws;
      if (this.byName(teamId, name)) throw new HttpError(409, 'conflict', `This team already has a workspace named ${name}.`);
      this.db.prepare('UPDATE workspaces SET name = ? WHERE id = ?').run(name, id);
      return { ...ws, name };
    });
  }

  // Soft delete: the folder goes to the trash, the row and its tokens stop
  // working. The caller closes the workspace's engine first (open files).
  remove(teamId, id) {
    const ws = this.byId(teamId, id);
    if (!ws) throw new HttpError(404, 'not_found', 'Not found.');
    const t = this.now();
    const from = this.dirOf(ws);
    if (fs.existsSync(from)) {
      const to = path.join(this.trash, ws.team_id, `${ws.id}-${t}`);
      fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
      fs.renameSync(from, to);
    }
    tx(this.db, () => {
      this.db.prepare('UPDATE workspaces SET deleted_at = ? WHERE id = ?').run(t, ws.id);
      this.db.prepare('UPDATE workspace_tokens SET revoked_at = ? WHERE workspace_id = ? AND revoked_at IS NULL').run(t, ws.id);
    });
    return ws;
  }

  // ---- Tokens ----

  // opts (the platform API): { expiresAt (ms), agentName (pins the run
  // identity to <name>/<agentName>, validated by the caller) }.
  createToken(ws, actor, rawName, rawScope, { expiresAt = null, agentName = null } = {}) {
    const name = String(rawName ?? '').trim();
    if (!TOKEN_NAME_RE.test(name)) throw new HttpError(400, 'bad_request', 'Name the token with 1 to 40 letters, digits, dots, dashes or underscores (it prefixes the agent names in the ledger).');
    const scope = rawScope === 'read' ? 'read' : rawScope === 'write' ? 'write' : null;
    if (!scope) throw new HttpError(400, 'bad_request', 'Pick read or write access.');
    const token = WS_TOKEN_PREFIX + randomToken(32);
    const id = randomId(9);
    tx(this.db, () => {
      // Expired tokens no longer count as live.
      const live = this.db.prepare('SELECT COUNT(*) AS n FROM workspace_tokens WHERE workspace_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)').get(ws.id, this.now()).n;
      if (live >= MAX_TOKENS) throw new HttpError(409, 'conflict', `This workspace has ${MAX_TOKENS} live tokens. Revoke some first.`);
      if (this.db.prepare('SELECT 1 FROM workspace_tokens WHERE workspace_id = ? AND name = ?').get(ws.id, name)) {
        throw new HttpError(409, 'conflict', `A token named ${name} exists or existed in this workspace. Its agents keep that name in the history, so pick another.`);
      }
      this.db
        .prepare('INSERT INTO workspace_tokens (id, workspace_id, team_id, user_id, name, scope, token_hash, hint, created_at, expires_at, agent_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, ws.id, ws.team_id, actor.userId, name, scope, sha256(token), token.slice(-4), this.now(), expiresAt, agentName);
    });
    return { id, name, scope, token, expires_at: expiresAt, agent_name: agentName };
  }

  // Owners see every live token of the workspace; members see their own.
  tokens(ws, actor) {
    return this.db
      .prepare(
        `SELECT t.id, t.name, t.scope, t.hint, t.created_at, t.last_used_at, t.user_id, u.login AS owner
         FROM workspace_tokens t LEFT JOIN users u ON u.id = t.user_id
         WHERE t.workspace_id = ? AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > ?) ORDER BY t.created_at DESC`,
      )
      .all(ws.id, this.now())
      .filter((r) => actor.role === 'owner' || r.user_id === actor.userId);
  }

  revokeToken(ws, actor, tokenId) {
    const row = this.db.prepare('SELECT user_id FROM workspace_tokens WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL').get(String(tokenId), ws.id);
    if (!row || (actor.role !== 'owner' && row.user_id !== actor.userId)) throw new HttpError(404, 'not_found', 'No such token.');
    this.db.prepare('UPDATE workspace_tokens SET revoked_at = ? WHERE id = ? AND workspace_id = ?').run(this.now(), String(tokenId), ws.id);
  }

  // { token, workspace } for a live token of a live workspace whose creator
  // is still in the team, else null.
  authenticate(raw) {
    if (typeof raw !== 'string' || !raw.startsWith(WS_TOKEN_PREFIX) || raw.length > 100) return null;
    const hash = sha256(raw);
    const row = this.db.prepare('SELECT * FROM workspace_tokens WHERE token_hash = ?').get(hash);
    if (!row || !same(row.token_hash, hash) || row.revoked_at) return null;
    const t = this.now();
    // A token minted with a TTL (the platform API) stops at expires_at; tokens without one never expire.
    if (row.expires_at !== null && row.expires_at !== undefined && t >= row.expires_at) return null;
    const ws = this.db.prepare('SELECT * FROM workspaces WHERE id = ? AND deleted_at IS NULL').get(row.workspace_id);
    if (!ws || ws.team_id !== row.team_id) return null;
    if (!this.db.prepare('SELECT 1 FROM members WHERE team_id = ? AND user_id = ?').get(row.team_id, row.user_id)) return null;
    if (!row.last_used_at || t - row.last_used_at > 60_000) this.db.prepare('UPDATE workspace_tokens SET last_used_at = ? WHERE id = ?').run(t, row.id);
    return { token: row, workspace: ws };
  }
}
