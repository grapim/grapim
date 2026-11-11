// `grapim sync`: push this repo's ledger (runs, changes, events, agents and
// the file contents they reference) to a team hub.
//
// A cursor per hub, repo and token lives in the state dir. Each push sends
// what is newer than the cursor, in batches under the hub's 8 MB limit, and
// stores the cursor the hub answers with. The hub is the source of truth: if
// it has less than we think (a new hub, another team), it says so with 409
// and we resend from where it is. Sending the same rows twice is harmless.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CURSOR_FILE = 'hub-sync.json';
const MAX_CHANGES = 500;
const MAX_EVENTS = 2000;
const BLOB_BUDGET = 6 * 1024 * 1024; // base64 bytes per batch, under the hub's 8 MB body limit

export class SyncError extends Error {
  constructor(message, status = null, code = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// The hub URL as an origin. The token must never travel over plain http,
// except to a hub on this machine.
export function hubOrigin(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new SyncError(`Not a URL: ${url}`);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new SyncError('The hub URL must start with https:// (http only for localhost).');
  return u.origin;
}

// A repo's identity across clones: the sha1 of its root commit.
export function repoIdentity(ws) {
  if (!ws.isGit) throw new SyncError('grapim sync works in a git repo.');
  let out = '';
  try {
    out = execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: ws.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  } catch {}
  const roots = out.split(/\s+/).filter((s) => /^[0-9a-f]{40}$/.test(s)).sort();
  if (!roots.length) throw new SyncError('This repo has no commits yet. Commit once, then sync.');
  return { id: roots[0], name: String(ws.repo || path.basename(ws.root)).slice(0, 100) || 'repo' };
}

export function machineName(env = process.env) {
  const raw = env.GRAPIM_MACHINE || os.hostname() || 'machine';
  return raw.replace(/[^A-Za-z0-9._ -]/g, '-').slice(0, 100) || 'machine';
}

const clip = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n - 1) + '…' : s);

const cursorKey = (origin, repoId, token) => `${origin}|${repoId}|${crypto.createHash('sha256').update(token).digest('hex').slice(0, 16)}`;

function readCursors(stateDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(stateDir, CURSOR_FILE), 'utf8')) || {};
  } catch {
    return {};
  }
}

function writeCursor(stateDir, key, cursor) {
  const all = readCursors(stateDir);
  all[key] = { ...cursor, at: Date.now() };
  const file = path.join(stateDir, CURSOR_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
  fs.renameSync(tmp, file);
}

// Everything newer than `cursor`, within the batch limits. `more` says
// whether another batch is waiting.
export function buildBatch(store, cursor, { budget = BLOB_BUDGET } = {}) {
  const db = store.db;
  const rows = db.prepare('SELECT * FROM changes WHERE id > ? ORDER BY id LIMIT ?').all(cursor.changes, MAX_CHANGES);
  const blobs = {};
  let used = 0;
  const changes = [];
  let cut = false;
  for (const c of rows) {
    const add = {};
    for (const sha of [c.before_sha, c.after_sha]) {
      if (!sha || sha === 'untracked' || blobs[sha] || add[sha]) continue;
      const buf = store.blob(sha);
      if (buf) add[sha] = buf.toString('base64');
    }
    const size = Object.values(add).reduce((n, s) => n + s.length, 0);
    if (changes.length && used + size > budget) {
      cut = true;
      break;
    }
    Object.assign(blobs, add);
    used += size;
    changes.push({
      id: c.id,
      run: c.run,
      label: clip(c.label, 200),
      turn: c.turn,
      // The worktree's folder name only: local absolute paths stay local.
      worktree: path.basename(c.root),
      path: c.path,
      before_sha: c.before_sha,
      after_sha: c.after_sha,
      untracked: !!c.untracked,
      added: c.added,
      removed: c.removed,
      ts: c.ts,
    });
  }
  // Long free text is clipped to the hub's limits rather than failing the batch.
  const events = db
    .prepare('SELECT id, ts, agent, kind, path, detail FROM events WHERE id > ? ORDER BY id LIMIT ?')
    .all(cursor.events, MAX_EVENTS)
    .map((e) => ({ ...e, detail: clip(e.detail, 2000) }));
  const agents = db
    .prepare('SELECT agent, label, intent, worktree, last_seen FROM agents WHERE last_seen > ? ORDER BY last_seen LIMIT 5000')
    .all(cursor.agents)
    .map((a) => ({ ...a, label: clip(a.label, 200), intent: clip(a.intent, 2000), worktree: clip(a.worktree, 200) }));
  const names = new Set([...changes.map((c) => c.run), ...events.map((e) => e.agent), ...agents.map((a) => a.agent)]);
  const getRun = db.prepare('SELECT run, turn, started_at FROM runs WHERE run = ?');
  const runs = [...names].map((n) => getRun.get(n)).filter(Boolean);
  return {
    changes,
    events,
    agents,
    runs,
    blobs,
    more: cut || rows.length === MAX_CHANGES || events.length === MAX_EVENTS,
    empty: !changes.length && !events.length && !agents.length,
  };
}

async function post(fetchImpl, origin, token, body) {
  let res;
  try {
    res = await fetchImpl(`${origin}/hub/api/sync`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      // The hub never redirects /hub/api/sync. Refusing redirects keeps the
      // token and the code from being re-sent to another host or over http.
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    throw new SyncError(`Could not reach the hub at ${origin}: ${err.cause?.code || err.message}`);
  }
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

// Pushes everything newer than the stored cursor. Returns totals.
export async function syncOnce({ ws, store, hubUrl, token, fetch: fetchImpl = globalThis.fetch, machine = machineName(), maxBatches = 200, budget } = {}) {
  if (!token) throw new SyncError('No hub token. Pass --token or set GRAPIM_HUB_TOKEN.');
  const origin = hubOrigin(hubUrl);
  const repo = repoIdentity(ws);
  const key = cursorKey(origin, repo.id, token);
  const saved = readCursors(ws.stateDir)[key];
  let cursor = { changes: saved?.changes ?? 0, events: saved?.events ?? 0, agents: saved?.agents ?? 0 };
  const total = { batches: 0, changes: 0, events: 0, agents: 0, runs: 0, blobs: 0, repo: repo.id };
  let resets = 0;
  for (let i = 0; i < maxBatches; i++) {
    const b = buildBatch(store, cursor, { budget });
    const { status, data } = await post(fetchImpl, origin, token, {
      repo,
      machine,
      cursor,
      runs: b.runs,
      agents: b.agents,
      changes: b.changes,
      events: b.events,
      blobs: b.blobs,
    });
    if (status === 409 && data?.error?.code === 'cursor_mismatch' && data.cursor && resets++ < 2) {
      cursor = { changes: data.cursor.changes ?? 0, events: data.cursor.events ?? 0, agents: data.cursor.agents ?? 0 };
      writeCursor(ws.stateDir, key, cursor);
      continue;
    }
    if (status !== 200 || !data?.cursor) {
      const msg = data?.error?.message || `the hub answered ${status}`;
      throw new SyncError(status === 401 ? `The hub rejected the token: ${msg}` : `Sync failed: ${msg}`, status, data?.error?.code ?? null);
    }
    cursor = { changes: data.cursor.changes, events: data.cursor.events, agents: data.cursor.agents };
    writeCursor(ws.stateDir, key, cursor);
    total.batches++;
    total.changes += b.changes.length;
    total.events += b.events.length;
    total.agents += b.agents.length;
    total.runs += b.runs.length;
    total.blobs += Object.keys(b.blobs).length;
    if (!b.more) break;
  }
  total.cursor = cursor;
  return total;
}

// Syncs every `intervalMs`; after an error, waits longer (doubling, up to
// 5 minutes, with jitter) until a sync succeeds again. Returns { stop }.
export function syncWatch(opts) {
  const { intervalMs = 5000, maxBackoffMs = 5 * 60 * 1000, onResult = () => {}, onError = () => {} } = opts;
  let failures = 0;
  let timer = null;
  let stopped = false;
  const loop = async () => {
    if (stopped) return;
    try {
      onResult(await syncOnce(opts));
      failures = 0;
    } catch (err) {
      failures++;
      onError(err, failures);
      // A rejected token or a plan limit will not fix itself quickly: back off hard.
    }
    if (stopped) return;
    const wait = failures ? Math.min(maxBackoffMs, intervalMs * 2 ** failures) * (0.8 + Math.random() * 0.4) : intervalMs;
    timer = setTimeout(loop, wait);
  };
  loop();
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
