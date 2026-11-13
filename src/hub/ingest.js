// POST /hub/api/sync: one batch of a repo's runs, changes, events and blobs
// from one machine. The whole batch is validated before anything is written,
// then written in one transaction, so a bad batch leaves no partial state.
//
// Idempotent: rows are keyed by (team, repo, machine, local id), and a row
// seen before is left as it was. Blobs must hash to their sha and be used by a
// change in the same batch.

import { tx } from './db.js';
import { HttpError, badRequest } from './http.js';
import { sha1 } from './secure.js';
import { codeStorageOf } from './code-storage.js';
import { parseGitHub, parseProvenance, provenanceBytes, storeProvenance } from './provenance.js';
import { parseInventory, storeInventory } from './inventory.js';

export const MAX_BATCH = 8 * 1024 * 1024;
export const MAX_BLOB = 2 * 1024 * 1024;
const MAX_ROWS = { runs: 5000, changes: 5000, events: 20000, agents: 5000, blobs: 2000 };

const SHA = /^[0-9a-f]{40}$/;
const isSha = (v) => v === null || v === 'untracked' || (typeof v === 'string' && SHA.test(v));
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

function str(v, name, max, { optional = false } = {}) {
  if (v === null || v === undefined) {
    if (optional) return null;
    throw badRequest(`${name} is required.`);
  }
  if (typeof v !== 'string' || v.length > max || v.includes('\u0000')) throw badRequest(`${name} must be a string of at most ${max} characters.`);
  return v;
}

function int(v, name, { optional = false, min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if ((v === null || v === undefined) && optional) return null;
  if (!Number.isSafeInteger(v) || v < min || v > max) throw badRequest(`${name} must be an integer from ${min} to ${max}.`);
  return v;
}

// Epoch milliseconds a Date can hold. A larger value makes toISOString()
// throw, so one such synced row would break every page that shows it.
export const MAX_TS = 8.64e15;
const ts = (v, name) => int(v, name, { max: MAX_TS });

function list(v, name) {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw badRequest(`${name} must be an array.`);
  if (v.length > MAX_ROWS[name]) throw new HttpError(413, 'too_large', `At most ${MAX_ROWS[name]} ${name} per batch.`);
  return v;
}

const obj = (v, name) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw badRequest(`${name} must be an object.`);
  return v;
};

// Validates and normalises a batch. Throws HttpError on the first problem.
export function parseBatch(body) {
  obj(body, 'The body');
  const repo = obj(body.repo, 'repo');
  if (typeof repo.id !== 'string' || !SHA.test(repo.id)) throw badRequest('repo.id must be the 40-character sha1 of the repo root commit.');
  const repoName = str(repo.name, 'repo.name', 100).trim();
  if (!repoName) throw badRequest('repo.name is required.');
  const machine = str(body.machine, 'machine', 100).trim();
  if (!/^[A-Za-z0-9._ -]+$/.test(machine)) throw badRequest('machine must be a name of letters, digits, dot, dash, underscore or space.');
  const c = body.cursor === undefined || body.cursor === null ? {} : obj(body.cursor, 'cursor');
  const cursor = {
    changes: int(c.changes ?? 0, 'cursor.changes'),
    events: int(c.events ?? 0, 'cursor.events'),
    agents: int(c.agents ?? 0, 'cursor.agents'),
  };

  const runs = list(body.runs, 'runs').map((r, i) => ({
    run: str(obj(r, `runs[${i}]`).run, `runs[${i}].run`, 200),
    turn: int(r.turn ?? 0, `runs[${i}].turn`),
    started_at: ts(r.started_at ?? 0, `runs[${i}].started_at`),
  }));
  const agents = list(body.agents, 'agents').map((a, i) => ({
    agent: str(obj(a, `agents[${i}]`).agent, `agents[${i}].agent`, 200),
    label: str(a.label, `agents[${i}].label`, 200, { optional: true }),
    intent: str(a.intent, `agents[${i}].intent`, 2000, { optional: true }),
    worktree: str(a.worktree, `agents[${i}].worktree`, 200, { optional: true }),
    last_seen: ts(a.last_seen, `agents[${i}].last_seen`),
  }));
  const changes = list(body.changes, 'changes').map((x, i) => {
    obj(x, `changes[${i}]`);
    if (!isSha(x.before_sha ?? null) || !isSha(x.after_sha ?? null)) throw badRequest(`changes[${i}] has an invalid sha.`);
    return {
      id: int(x.id, `changes[${i}].id`, { min: 1 }),
      run: str(x.run, `changes[${i}].run`, 200),
      label: str(x.label, `changes[${i}].label`, 200, { optional: true }),
      turn: int(x.turn ?? 0, `changes[${i}].turn`),
      worktree: str(x.worktree ?? '', `changes[${i}].worktree`, 200),
      path: str(x.path, `changes[${i}].path`, 1024),
      before_sha: x.before_sha ?? null,
      after_sha: x.after_sha ?? null,
      untracked: x.untracked ? 1 : 0,
      added: int(x.added, `changes[${i}].added`, { optional: true }),
      removed: int(x.removed, `changes[${i}].removed`, { optional: true }),
      ts: ts(x.ts, `changes[${i}].ts`),
    };
  });
  const events = list(body.events, 'events').map((e, i) => {
    obj(e, `events[${i}]`);
    const kind = str(e.kind, `events[${i}].kind`, 20);
    if (!/^[a-z_]+$/.test(kind)) throw badRequest(`events[${i}].kind is not a valid kind.`);
    return {
      id: int(e.id, `events[${i}].id`, { min: 1 }),
      ts: ts(e.ts, `events[${i}].ts`),
      agent: str(e.agent, `events[${i}].agent`, 200),
      kind,
      path: str(e.path, `events[${i}].path`, 1024, { optional: true }),
      detail: str(e.detail, `events[${i}].detail`, 2000, { optional: true }),
    };
  });

  // Blobs: base64, at most 2 MB each, sha1 of the content must match, and
  // each must be used by a change in this batch.
  const used = new Set(changes.flatMap((x) => [x.before_sha, x.after_sha]).filter((s) => s && s !== 'untracked'));
  const rawBlobs = body.blobs === undefined || body.blobs === null ? {} : obj(body.blobs, 'blobs');
  const shas = Object.keys(rawBlobs);
  if (shas.length > MAX_ROWS.blobs) throw new HttpError(413, 'too_large', `At most ${MAX_ROWS.blobs} blobs per batch.`);
  const blobs = new Map();
  for (const sha of shas) {
    if (!SHA.test(sha)) throw badRequest(`Blob key ${sha.slice(0, 50)} is not a sha1.`);
    const b64 = rawBlobs[sha];
    if (typeof b64 !== 'string' || b64.length % 4 !== 0 || !B64.test(b64)) throw badRequest(`Blob ${sha} is not valid base64.`);
    if ((b64.length / 4) * 3 > MAX_BLOB + 2) throw new HttpError(413, 'too_large', `Blob ${sha} is over ${MAX_BLOB} bytes.`);
    const buf = Buffer.from(b64, 'base64');
    if (buf.length > MAX_BLOB) throw new HttpError(413, 'too_large', `Blob ${sha} is over ${MAX_BLOB} bytes.`);
    if (sha1(buf) !== sha) throw new HttpError(400, 'sha_mismatch', `Blob ${sha} does not match its content.`);
    if (!used.has(sha)) throw badRequest(`Blob ${sha} is not used by any change in this batch.`);
    blobs.set(sha, buf);
  }

  // Provenance notes and the GitHub repo (src/hub/provenance.js).
  const github = parseGitHub(repo.github);
  const provenance = parseProvenance(body.provenance);

  // The agent inventory, optional (src/hub/inventory.js).
  const inventory = parseInventory(body.inventory);

  return { repo: { id: repo.id, name: repoName, github }, machine, cursor, runs, agents, changes, events, blobs, provenance, inventory };
}

// Approximate stored size of one row, for the per-team storage quota.
const ROW_OVERHEAD = 64;
const rowBytes = (row) => {
  let n = ROW_OVERHEAD;
  for (const v of Object.values(row)) if (typeof v === 'string') n += Buffer.byteLength(v);
  return n;
};

// Upper bound of what a batch can add to the team's stored bytes.
function batchBytes(batch, { blobs = true } = {}) {
  let n = 0;
  if (blobs) for (const buf of batch.blobs.values()) n += buf.length;
  for (const list of [batch.runs, batch.agents, batch.changes, batch.events]) for (const r of list) n += rowBytes(r);
  n += provenanceBytes(batch.provenance ?? []);
  return n;
}

// Stored bytes of a team (blobs plus approximate row sizes), kept in
// team_usage. A team that has no row yet (data synced before the quota
// existed) starts from the size of its blobs.
export function usageOf(db, teamId) {
  const row = db.prepare('SELECT bytes FROM team_usage WHERE team_id = ?').get(teamId);
  if (row) return row.bytes;
  const bytes = db.prepare('SELECT COALESCE(SUM(LENGTH(content)), 0) AS n FROM h_blobs WHERE team_id = ?').get(teamId).n;
  db.prepare('INSERT INTO team_usage (team_id, bytes) VALUES (?, ?)').run(teamId, bytes);
  return bytes;
}

export const DEFAULT_TEAM_STORAGE = 1024 * 1024 * 1024; // 1 GiB per team

export class Ingest {
  constructor({ db, now, limits, onSync = () => {}, storageBytes = DEFAULT_TEAM_STORAGE }) {
    this.db = db;
    this.now = now;
    this.limits = limits;
    this.onSync = onSync;
    this.storageBytes = storageBytes;
  }

  // auth: { token, team } from Teams.authenticate. Returns { status, body }.
  apply(auth, batch) {
    const { team, token } = auth;
    const t = this.now();
    const result = tx(this.db, () => {
      const repo = this.db.prepare('SELECT * FROM repos WHERE team_id = ? AND id = ?').get(team.id, batch.repo.id);
      if (!repo) {
        const { repos: maxRepos } = this.limits(team);
        const n = this.db.prepare('SELECT COUNT(*) AS n FROM repos WHERE team_id = ?').get(team.id).n;
        if (n >= maxRepos) {
          throw new HttpError(402, 'plan_limit', `This team's plan allows ${maxRepos} repo${maxRepos === 1 ? '' : 's'}. An owner can upgrade in billing.`);
        }
        this.db.prepare('INSERT INTO repos (team_id, id, name, created_at, last_sync_at) VALUES (?, ?, ?, ?, ?)').run(team.id, batch.repo.id, batch.repo.name, t, t);
      } else {
        this.db.prepare('UPDATE repos SET name = ?, last_sync_at = ? WHERE team_id = ? AND id = ?').run(batch.repo.name, t, team.id, batch.repo.id);
      }

      // A machine name belongs to the person who first synced it, so one
      // member cannot write rows into another member's machine.
      let m = this.db.prepare('SELECT * FROM machines WHERE team_id = ? AND repo_id = ? AND machine = ?').get(team.id, batch.repo.id, batch.machine);
      if (m && m.user_id !== token.user_id) {
        throw new HttpError(409, 'machine_taken', `The machine name "${batch.machine}" is already used by another member for this repo. Set GRAPIM_MACHINE to a different name.`);
      }
      if (!m) {
        this.db
          .prepare('INSERT INTO machines (team_id, repo_id, machine, user_id, token_id, last_sync_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(team.id, batch.repo.id, batch.machine, token.user_id, token.id, t);
        m = { cursor_changes: 0, cursor_events: 0, cursor_agents: 0 };
      }
      const have = { changes: m.cursor_changes, events: m.cursor_events, agents: m.cursor_agents };
      // "No code storage" (src/hub/code-storage.js): file contents are dropped
      // here, whatever the client sent, and only their hashes are kept.
      const codeStorage = codeStorageOf(this.db, team.id);
      const keepBlobs = codeStorage === 'full';
      // The client thinks it already sent rows the hub does not have (a new
      // hub, a different team): tell it where to restart from.
      if (batch.cursor.changes > have.changes || batch.cursor.events > have.events) {
        return { status: 409, body: { error: { code: 'cursor_mismatch', message: 'The hub has less than this machine sent. Resend from the returned cursor.' }, cursor: have, code_storage: codeStorage } };
      }

      // Per-team storage quota, so one team cannot fill the shared volume.
      const usedBytes = usageOf(this.db, team.id);
      if (usedBytes + batchBytes(batch, { blobs: keepBlobs }) > this.storageBytes) {
        throw new HttpError(413, 'storage_limit', `This team has used its ${Math.round(this.storageBytes / 1024 / 1024)} MB of hub storage.`);
      }
      let added = 0;

      const key = [team.id, batch.repo.id, batch.machine];
      const counts = { runs: 0, agents: 0, changes: 0, events: 0, blobs: 0, provenance: 0 };
      const putBlob = this.db.prepare('INSERT OR IGNORE INTO h_blobs (team_id, sha, content) VALUES (?, ?, ?)');
      for (const [sha, buf] of keepBlobs ? batch.blobs : []) {
        const n = putBlob.run(team.id, sha, buf).changes;
        counts.blobs += n;
        if (n) added += buf.length;
      }
      // Runs and agents are upserts: only a new row adds to the stored bytes.
      const hasRun = this.db.prepare('SELECT 1 FROM h_runs WHERE team_id = ? AND repo_id = ? AND machine = ? AND run = ?');
      const hasAgent = this.db.prepare('SELECT 1 FROM h_agents WHERE team_id = ? AND repo_id = ? AND machine = ? AND agent = ?');
      for (const r of batch.runs) if (!hasRun.get(...key, r.run)) added += rowBytes(r);
      for (const a of batch.agents) if (!hasAgent.get(...key, a.agent)) added += rowBytes(a);
      const putRun = this.db.prepare(
        `INSERT INTO h_runs (team_id, repo_id, machine, run, turn, started_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(team_id, repo_id, machine, run) DO UPDATE SET turn = MAX(h_runs.turn, excluded.turn)`,
      );
      for (const r of batch.runs) counts.runs += putRun.run(...key, r.run, r.turn, r.started_at).changes;
      const putAgent = this.db.prepare(
        `INSERT INTO h_agents (team_id, repo_id, machine, agent, label, intent, worktree, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(team_id, repo_id, machine, agent) DO UPDATE SET
           label = COALESCE(excluded.label, h_agents.label), intent = COALESCE(excluded.intent, h_agents.intent),
           worktree = COALESCE(excluded.worktree, h_agents.worktree), last_seen = MAX(h_agents.last_seen, excluded.last_seen)`,
      );
      for (const a of batch.agents) counts.agents += putAgent.run(...key, a.agent, a.label, a.intent, a.worktree, a.last_seen).changes;
      const putChange = this.db.prepare(
        `INSERT INTO h_changes (team_id, repo_id, machine, local_id, run, label, turn, worktree, path, before_sha, after_sha, untracked, added, removed, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(team_id, repo_id, machine, local_id) DO NOTHING`,
      );
      for (const c of batch.changes) {
        const n = putChange.run(...key, c.id, c.run, c.label, c.turn, c.worktree, c.path, c.before_sha, c.after_sha, c.untracked, c.added, c.removed, c.ts).changes;
        counts.changes += n;
        if (n) added += rowBytes(c);
      }
      const putEvent = this.db.prepare(
        `INSERT INTO h_events (team_id, repo_id, machine, local_id, ts, agent, kind, path, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(team_id, repo_id, machine, local_id) DO NOTHING`,
      );
      for (const e of batch.events) {
        const n = putEvent.run(...key, e.id, e.ts, e.agent, e.kind, e.path, e.detail).changes;
        counts.events += n;
        if (n) added += rowBytes(e);
      }
      if (batch.provenance?.length) {
        const p = storeProvenance(this.db, team.id, batch.repo.id, batch.provenance, t);
        counts.provenance = p.stored;
        added += p.bytes;
      }
      // At most one GitHub repo per hub repo: the newest sync names it.
      if (batch.repo.github) this.db.prepare('UPDATE repos SET github = ? WHERE team_id = ? AND id = ? AND github IS NOT ?').run(batch.repo.github, team.id, batch.repo.id, batch.repo.github);
      if (added) this.db.prepare('UPDATE team_usage SET bytes = bytes + ? WHERE team_id = ?').run(added, team.id);
      if (batch.inventory) counts.inventory = storeInventory(this.db, team.id, batch.repo.id, batch.machine, token.user_id, batch.inventory, t);

      const cursor = {
        changes: Math.max(have.changes, ...batch.changes.map((c) => c.id)),
        events: Math.max(have.events, ...batch.events.map((e) => e.id)),
        agents: Math.max(have.agents, ...batch.agents.map((a) => a.last_seen)),
      };
      this.db
        .prepare(
          `UPDATE machines SET cursor_changes = ?, cursor_events = ?, cursor_agents = ?, token_id = ?, last_sync_at = ?
           WHERE team_id = ? AND repo_id = ? AND machine = ?`,
        )
        .run(cursor.changes, cursor.events, cursor.agents, token.id, t, ...key);
      return { status: 200, body: { ok: true, repo: batch.repo.id, cursor, stored: counts, code_storage: codeStorage } };
    });
    if (result.status === 200 && (result.body.stored.changes || result.body.stored.events || result.body.stored.agents || result.body.stored.provenance)) {
      this.onSync(team.id, batch.repo.id);
    }
    return result;
  }
}
