// `grapim sync`: push this repo's ledger (runs, changes, events, agents and
// the file contents they reference) to a team hub.
//
// A cursor per hub, repo and token lives in the state dir. Each push sends
// what is newer than the cursor, in batches under the hub's 8 MB limit, and
// stores the cursor the hub answers with. The hub is the source of truth: if
// it has less than we think (a new hub, another team), it says so with 409
// and we resend from where it is. Sending the same rows twice is harmless.
//
// A team with "No code storage" on answers code_storage: 'metadata'. Then no
// file contents are sent, only their hashes. The mode is kept with the cursor;
// before the first sync to a hub it is learnt from an empty batch, so contents
// never leave the machine for such a team. A hub that does not answer the
// field keeps everything ('full').

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NOTE_REF, parseNote, serializeNote } from './provenance/note.js';
import { readBlobs } from './provenance/git.js';
import { collectInventory, inventoryHash, SEEN_SINCE } from './inventory.js';

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

// The origin remote as github.com/owner/name, or null (no origin, or not
// GitHub). Credentials in the URL never leave this function.
export function githubRemote(url) {
  if (typeof url !== 'string') return null;
  const u = url.trim();
  let m = /^(?:[A-Za-z0-9._~-]+@)?(?:www\.)?github\.com:\/?([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(u); // scp-like: git@github.com:o/n.git
  if (!m) {
    try {
      const p = new URL(u);
      if (!['https:', 'http:', 'ssh:', 'git:', 'git+ssh:', 'ssh+git:'].includes(p.protocol) || !/^(www\.)?github\.com$/i.test(p.hostname)) return null;
      m = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(decodeURIComponent(p.pathname));
    } catch {
      return null;
    }
  }
  if (!m) return null;
  const [, owner, name] = m;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(name) || name === '.' || name === '..') return null;
  return `github.com/${owner}/${name}`;
}

function originGitHub(ws) {
  try {
    const url = execFileSync('git', ['config', '--get', 'remote.origin.url'], { cwd: ws.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    return githubRemote(url);
  } catch {
    return null;
  }
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
export function buildBatch(store, cursor, { budget = BLOB_BUDGET, contents = true } = {}) {
  const db = store.db;
  const rows = db.prepare('SELECT * FROM changes WHERE id > ? ORDER BY id LIMIT ?').all(cursor.changes, MAX_CHANGES);
  const blobs = {};
  let used = 0;
  const changes = [];
  let cut = false;
  for (const c of rows) {
    const add = {};
    for (const sha of contents ? [c.before_sha, c.after_sha] : []) {
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
      // The shell command that made it (src/shell.js); left out for an edit tool.
      ...(c.via ? { via: clip(c.via, 300) } : {}),
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

// ---- Provenance notes (docs/provenance.md section 3) ----
// The sync state keeps { base, target, after }: base is the notes commit
// whose notes have all been sent; a pass sends the notes added or changed
// between base and target, in commit order, and `after` is the last commit
// sent in the pass. When the pass ends, base = target.

const MAX_NOTES = 200;
const NOTES_BUDGET = 1024 * 1024; // note bytes per batch

function gitOut(ws, args, input) {
  try {
    return execFileSync('git', args, { cwd: ws.root, input, encoding: 'utf8', stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'], windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  } catch {
    return null;
  }
}

// commit -> note blob, for every note in the ref at `rev`.
function notesAt(ws, rev) {
  const out = gitOut(ws, ['ls-tree', '-r', '-z', rev]) ?? '';
  const map = new Map();
  for (const entry of out.split('\0')) {
    const m = /^\d+ blob ([0-9a-f]{40,64})\t(.+)$/.exec(entry);
    if (!m) continue;
    const commit = m[2].replace(/\//g, '');
    if (/^[0-9a-f]{40}$/.test(commit)) map.set(commit, m[1]);
  }
  return map;
}

export function buildNotes(ws, state = {}, { max = MAX_NOTES, budget = NOTES_BUDGET } = {}) {
  const head = gitOut(ws, ['rev-parse', '--verify', '--quiet', NOTE_REF])?.trim() || null;
  if (!head) return { provenance: [], state: {}, more: false };
  const base = state.base || null;
  if (base === head) return { provenance: [], state: { base: head, target: head, after: '' }, more: false };
  const after = state.target === head ? state.after || '' : '';
  const now = notesAt(ws, head);
  const old = base ? notesAt(ws, base) : null;
  // Notes added or changed since base (all of them if base is gone).
  let commits = old && old.size ? [...now].filter(([c, b]) => old.get(c) !== b).map(([c]) => c) : [...now.keys()];
  commits = commits.sort().filter((c) => c > after);
  // One git process for every note text of this batch.
  let texts = new Map();
  try {
    texts = readBlobs(ws.root, commits.slice(0, max).map((c) => now.get(c)));
  } catch {}
  const provenance = [];
  let used = 0;
  let last = after;
  for (const commit of commits) {
    if (provenance.length >= max) break;
    const text = texts.get(now.get(commit));
    last = commit;
    let note;
    try {
      // Concatenated notes are merged here, so the hub gets one clean note.
      note = serializeNote(parseNote(text ?? ''));
    } catch {
      continue; // a note this client cannot read is not sent
    }
    if (provenance.length && used + note.length > budget) {
      last = provenance.at(-1).commit;
      break;
    }
    used += note.length;
    provenance.push({ commit, note });
  }
  const done = !commits.length || last === commits.at(-1);
  return {
    provenance,
    state: done ? { base: head, target: head, after: '' } : { base, target: head, after: last },
    more: !done,
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
    const why = err.name === 'TimeoutError' ? 'no answer in 60 s' : err.cause?.code || err.cause?.errors?.[0]?.code || err.cause?.message || err.message;
    throw new SyncError(`Could not reach the hub at ${origin} (${why}). Check the address and your connection, then run grapim sync again.`);
  }
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

// The agent inventory (src/inventory.js), when one is due: looked at again
// at most every 5 minutes, sent when it changed or an hour after it was last
// sent (so the hub's "last seen" stays fresh). GRAPIM_NO_INVENTORY=1 or
// inventory: false turns it off. -> { inventory: object | null, state }
const INVENTORY_LOOK_MS = 5 * 60 * 1000;
const INVENTORY_RESEND_MS = 60 * 60 * 1000;
export function dueInventory({ ws, store, state = {}, home, env = process.env, now = Date.now() }) {
  if (env.GRAPIM_NO_INVENTORY === '1') return { inventory: null, state };
  if (state.sentAt && now - state.sentAt < INVENTORY_RESEND_MS && state.lookedAt && now - state.lookedAt < INVENTORY_LOOK_MS) return { inventory: null, state };
  let inv;
  try {
    let seen = [];
    try {
      seen = store.seen(SEEN_SINCE());
    } catch {}
    inv = collectInventory({ root: ws.root, home, env, seen });
  } catch {
    return { inventory: null, state }; // never let discovery fail a sync
  }
  const hash = inventoryHash(inv);
  const next = { ...state, lookedAt: now };
  if (hash === state.hash && state.sentAt && now - state.sentAt < INVENTORY_RESEND_MS) return { inventory: null, state: next };
  return { inventory: inv, state: next, hash };
}

// Pushes everything newer than the stored cursor. Returns totals.
export async function syncOnce({ ws, store, hubUrl, token, fetch: fetchImpl = globalThis.fetch, machine = machineName(), maxBatches = 200, budget, inventory: withInventory = true, home = os.homedir() } = {}) {
  if (!token) throw new SyncError('No hub token. Pass --token or set GRAPIM_HUB_TOKEN.');
  const origin = hubOrigin(hubUrl);
  const repo = repoIdentity(ws);
  const github = originGitHub(ws);
  if (github) repo.github = github;
  const key = cursorKey(origin, repo.id, token);
  const saved = readCursors(ws.stateDir)[key];
  let cursor = { changes: saved?.changes ?? 0, events: saved?.events ?? 0, agents: saved?.agents ?? 0 };
  let notes = saved?.notes ?? {};
  // The inventory rides on the first batch the hub accepts.
  const due = withInventory ? dueInventory({ ws, store, state: saved?.inventory ?? {}, home }) : { inventory: null, state: saved?.inventory ?? {} };
  let inv = due.state;
  let pendingInventory = due.inventory;
  // 'full' | 'metadata' | undefined (not known yet: ask with an empty batch first).
  let mode = saved?.code_storage === 'metadata' || saved?.code_storage === 'full' ? saved.code_storage : undefined;
  const save = () => writeCursor(ws.stateDir, key, { ...cursor, notes, code_storage: mode, inventory: inv });
  const total = { batches: 0, changes: 0, events: 0, agents: 0, runs: 0, blobs: 0, notes: 0, repo: repo.id };
  let resets = 0;
  for (let i = 0; i < maxBatches; i++) {
    const probe = mode === undefined;
    const contents = mode === 'full';
    const b = probe ? { changes: [], events: [], agents: [], runs: [], blobs: {}, more: true } : buildBatch(store, cursor, { budget, contents });
    const n = probe || !ws.isGit ? { provenance: [], state: notes, more: false } : buildNotes(ws, notes);
    const { status, data } = await post(fetchImpl, origin, token, {
      repo,
      machine,
      cursor,
      runs: b.runs,
      agents: b.agents,
      changes: b.changes,
      events: b.events,
      blobs: b.blobs,
      provenance: n.provenance,
      ...(pendingInventory ? { inventory: pendingInventory } : {}),
    });
    const answered = data?.code_storage === 'metadata' ? 'metadata' : 'full';
    if (status === 409 && data?.error?.code === 'cursor_mismatch' && data.cursor && resets++ < 2) {
      cursor = { changes: data.cursor.changes ?? 0, events: data.cursor.events ?? 0, agents: data.cursor.agents ?? 0 };
      notes = {}; // the hub lost data: send every note again too
      if (data.code_storage) mode = answered;
      save();
      continue;
    }
    if (status !== 200 || !data?.cursor) {
      const msg = data?.error?.message || `the hub answered ${status}`;
      throw new SyncError(status === 401 ? `The hub rejected the token: ${msg} Create a new one in the hub (Settings, Machine tokens) and put it in GRAPIM_HUB_TOKEN.` : `Sync failed: ${msg}`, status, data?.error?.code ?? null);
    }
    if (probe) {
      mode = answered;
      save();
      continue;
    }
    // The team turned "No code storage" off since the last sync: this batch
    // went without contents, so send it again with them (rows already stored
    // are left as they are; the contents are added).
    if (!contents && answered === 'full' && b.changes.length) {
      mode = 'full';
      continue;
    }
    mode = answered;
    cursor = { changes: data.cursor.changes, events: data.cursor.events, agents: data.cursor.agents };
    notes = n.state;
    if (pendingInventory) {
      inv = { ...inv, hash: due.hash, sentAt: Date.now() };
      total.inventory = { agents: pendingInventory.agents.length, mcp: pendingInventory.mcp.length };
      pendingInventory = null;
    }
    save();
    total.batches++;
    total.notes += n.provenance.length;
    total.changes += b.changes.length;
    total.events += b.events.length;
    total.agents += b.agents.length;
    total.runs += b.runs.length;
    total.blobs += Object.keys(b.blobs).length;
    if (!b.more && !n.more) break;
  }
  total.cursor = cursor;
  total.code_storage = mode ?? 'full';
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
