// Review state and per-run branches: the GitHub half of Grapim.
//
// getReview(store, run)            -> { status, note, at, by } | null
// setReview(store, run, status, { note, by }) -> { status, note, at, by }
//   status: 'pending' | 'approved' | 'rejected'
// autoApprove(store, run, by)      -> the review: approved, note "automatic"
// branchOf(store, run)             -> 'grapim/…' | null
// createBranch(store, ws, run, { by }) -> { branch, commit, files: [{ path, status }] }
//   run: a full run id (resolve prefixes with findRun from ./undo.js first)
//
// A branch is built with git plumbing only, from HEAD, in a temporary index:
// the working tree, the real index and HEAD are never touched. Per file, the
// run's segments (see undo.js) are replayed onto the HEAD version with a
// three-way merge, current=HEAD, base=before, other=after, which adds exactly
// the run's edits. Blobs are stored byte for byte (hash-object --no-filters).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { history } from './attribution.js';
import { sha1 } from './ledger.js';
import { mergeFile, segments } from './undo.js';

export const STATUSES = Object.freeze(['pending', 'approved', 'rejected']);
export const AGENT_EMAIL = 'agent@grapim.local';

const fail = (code, message) => Object.assign(new Error(message), { code });

// ---- Review state ----

const ready = new WeakSet();
function table(store) {
  if (ready.has(store)) return;
  store.db.exec(`CREATE TABLE IF NOT EXISTS reviews (
    run        TEXT PRIMARY KEY,
    status     TEXT,
    note       TEXT,
    at         INTEGER,
    reviewer   TEXT,
    branch     TEXT,
    commit_sha TEXT,
    branch_at  INTEGER
  )`);
  ready.add(store);
}

const row = (store, run) => {
  table(store);
  return store.db.prepare('SELECT * FROM reviews WHERE run = ?').get(run) ?? null;
};

export function getReview(store, run) {
  const r = row(store, run);
  return r?.status ? { status: r.status, note: r.note, at: r.at, by: r.reviewer } : null;
}

// `by` is recorded as the review event's actor. event: false records no event
// (an automatic approval is not something anyone did).
export function setReview(store, run, status, { note = null, by = null, event = true } = {}) {
  if (!STATUSES.includes(status)) throw fail('bad_request', `status must be one of ${STATUSES.join(', ')}, not "${status}"`);
  if (!run) throw fail('bad_request', 'say which run');
  table(store);
  const review = { status, note: note === '' ? null : (note ?? null), at: store.now(), by: by ?? null };
  store.tx(() =>
    store.db
      .prepare(
        `INSERT INTO reviews (run, status, note, at, reviewer) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(run) DO UPDATE SET status = excluded.status, note = excluded.note, at = excluded.at, reviewer = excluded.reviewer`,
      )
      .run(run, review.status, review.note, review.at, review.by),
  );
  if (event) store.recordEvent(run, 'review', null, review.note ? `${status}: ${review.note}` : status, review.by);
  return review;
}

// Undo and restore runs are a human (or agent) reverting work, not new agent
// work: they are approved on creation so the review inbox only holds agent runs.
export const autoApprove = (store, run, by) => setReview(store, run, 'approved', { note: 'automatic', by, event: false });

export function branchOf(store, run) {
  return row(store, run)?.branch ?? null;
}

// ---- Git ----

function git(ws, args, { input, env } = {}) {
  try {
    return execFileSync('git', args, {
      cwd: ws.root,
      input,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (err) {
    if (err.code === 'ENOENT') throw fail('internal', 'git was not found on PATH. Branches need git.');
    throw Object.assign(fail('internal', `git ${args[0]} failed: ${String(err.stderr || err.message).trim()}`), { status: err.status });
  }
}

const gitText = (ws, args, opts) => git(ws, args, opts).toString('utf8').trim();

// The command's trimmed output, or null when git exits non-zero.
function gitMaybe(ws, args) {
  try {
    return gitText(ws, args) || null;
  } catch (err) {
    if (err.status === undefined) throw err;
    return null;
  }
}

const caseFold = process.platform === 'win32' || process.platform === 'darwin';
const norm = (p) => (caseFold ? p.toLowerCase() : p);

// Every blob in HEAD by (case-folded) path: { mode, sha, path }.
function headFiles(ws, head) {
  const out = new Map();
  if (!head) return out;
  for (const rec of git(ws, ['ls-tree', '-r', '-z', '--full-tree', head]).toString('utf8').split('\0')) {
    const m = /^(\d+) (\w+) ([0-9a-f]+)\t(.*)$/s.exec(rec);
    if (m && m[2] === 'blob') out.set(norm(m[4]), { mode: m[1], sha: m[3], path: m[4] });
  }
  return out;
}

// ---- Replaying a run's segments onto HEAD ----

const ABSENT = Object.freeze({ sha: null, buf: null });
const conflict = (reason) => ({ conflict: reason });

const CRLF = /\r\n/g;
const LONE_LF = /(?<!\r)\n/g;
function eolOf(buf) {
  const s = buf.toString('latin1');
  const crlf = (s.match(CRLF) ?? []).length;
  const lf = (s.match(LONE_LF) ?? []).length;
  if (crlf && !lf) return 'crlf';
  if (lf && !crlf) return 'lf';
  return 'other';
}
const toLf = (buf) => buf && Buffer.from(buf.toString('latin1').replace(CRLF, '\n'), 'latin1');
const toCrlf = (buf) => buf && Buffer.from(buf.toString('latin1').replace(LONE_LF, '\r\n'), 'latin1');

// With core.autocrlf the HEAD blob has LF while the working file (and so every
// snapshot the run recorded) has CRLF. Merging those as they are would make
// every line a conflict, so the snapshots are brought to HEAD's line endings
// first. Every line not edited by the run keeps HEAD's exact bytes.
function alignEol(head, before, after) {
  const h = eolOf(head);
  const b = eolOf(before);
  if (h === 'lf' && b === 'crlf') return [toLf(before), toLf(after)];
  if (h === 'crlf' && b === 'lf') return [toCrlf(before), toCrlf(after)];
  return [before, after];
}

// Adds one segment of the run to state (the file as the branch has it so far).
function applySegment(state, s) {
  if (s.untracked) return conflict('binary or over 2 MB: content was not recorded');
  if (state.sha === s.before_sha) return s.after === null ? ABSENT : { sha: s.after_sha, buf: s.after };
  if (state.sha === s.after_sha) return state; // already in HEAD
  if (s.before === null) return s.after === null ? state : conflict('this run created it, and HEAD has a different version');
  if (state.sha === null) return conflict('not in HEAD: it was created outside this run and never committed');
  const [base, other] = alignEol(state.buf, s.before, s.after);
  if (other === null) return base.equals(state.buf) ? ABSENT : conflict('this run deleted it, and HEAD has a different version than the one it deleted');
  let m;
  try {
    m = mergeFile(state.buf, base, other);
  } catch (err) {
    return conflict(err.message);
  }
  if (!m.clean) return conflict(`this run's edits overlap lines that differ in HEAD (${m.conflicts} conflicting hunk${m.conflicts === 1 ? '' : 's'})`);
  return { sha: sha1(m.buf), buf: m.buf };
}

// The run's net effect on each file it touched, replayed onto HEAD.
function planFiles(store, ws, run, head) {
  const tree = headFiles(ws, head);
  const files = new Map(); // norm(path) -> { path, mode, start, end, conflict }
  const seen = new Set();
  const mine = (c) => c.run === run;
  for (const c of store.changesOfRun(run)) {
    const k = `${c.root_key}|${c.path_key}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const entry = tree.get(norm(c.path));
    const key = norm(entry?.path ?? c.path);
    if (!files.has(key)) {
      const buf = entry ? git(ws, ['cat-file', 'blob', entry.sha]) : null;
      const start = buf ? { sha: sha1(buf), buf } : ABSENT;
      files.set(key, { path: entry?.path ?? c.path, mode: entry?.mode ?? '100644', start, end: start, conflict: null });
    }
    const f = files.get(key);
    if (f.conflict) continue;
    // segments() lists newest first; a branch replays them oldest first.
    for (const s of segments(history(store, c.root, c.path_key), mine).reverse()) {
      const next = applySegment(f.end, s);
      if (next.conflict) {
        f.conflict = next.conflict;
        break;
      }
      f.end = next;
    }
  }
  return [...files.values()];
}

// ---- The commit ----

export function slug(label) {
  const s = String(label ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
    .replace(/-$/, '');
  return s || 'run';
}

const ident = (s) => String(s).replace(/[<>\r\n]+/g, ' ').trim() || 'agent';
const firstLine = (s) => String(s ?? '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// The user's committer identity when git has one; otherwise the agent's, through env.
function committerEnv(ws, name) {
  const configured = (keys) => keys.map((k) => (k.startsWith('$') ? process.env[k.slice(1)] : gitMaybe(ws, ['config', '--get', k]))).find(Boolean);
  const hasName = configured(['$GIT_COMMITTER_NAME', 'committer.name', 'user.name']);
  const hasEmail = configured(['$GIT_COMMITTER_EMAIL', 'committer.email', 'user.email', '$EMAIL']);
  return hasName && hasEmail ? {} : { GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: AGENT_EMAIL };
}

const LETTER = (f) => (f.start.sha === null ? 'A' : f.end.sha === null ? 'D' : 'M');

function message(store, info, label, files) {
  const subject = cut(firstLine(info.intent) || `Changes by ${label}`, 72);
  const changes = store.changesOfRun(info.run);
  const intents = store.db.prepare(`SELECT detail FROM events WHERE agent = ? AND kind = 'intent' ORDER BY id`).all(info.run).map((e) => e.detail);
  const turns = new Map();
  for (const c of changes) {
    if (!turns.has(c.turn)) turns.set(c.turn, new Set());
    turns.get(c.turn).add(c.path);
  }
  const out = [subject, ''];
  out.push('Turns:');
  for (const [turn, paths] of [...turns].sort((a, b) => a[0] - b[0])) {
    // The hook records one intent per prompt, so intent k belongs to turn k when the counts agree.
    const said = intents.length === info.turns ? firstLine(intents[turn - 1]) : '';
    out.push(`  ${turn}. ${said ? `${cut(said, 100)} ` : ''}(${[...paths].join(', ')})`);
  }
  const changed = files.filter((f) => !f.conflict && f.end.sha !== f.start.sha);
  out.push('', 'Files:', ...changed.map((f) => `  ${LETTER(f)} ${f.path}`));
  const left = files.filter((f) => f.conflict);
  if (left.length) out.push('', 'Left out (conflict):', ...left.map((f) => `  ${f.path}: ${f.conflict}`));
  out.push('', `Grapim-Run: ${info.run}`);
  return out.join('\n') + '\n';
}

const refExists = (ws, ref) => gitMaybe(ws, ['rev-parse', '--verify', '--quiet', ref]) !== null;

// Creates refs/heads/grapim/<slug> (or -2, -3, …) pointing at commit, never moving an existing branch.
function makeRef(ws, base, commit, run) {
  if (gitMaybe(ws, ['check-ref-format', '--branch', base]) === null) throw fail('internal', `"${base}" is not a valid branch name`);
  for (let n = 1; n < 1000; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    const ref = `refs/heads/${name}`;
    if (refExists(ws, ref)) continue;
    try {
      // The empty old value makes git refuse if the ref appeared in the meantime.
      git(ws, ['update-ref', '-m', `grapim: branch for ${run}`, ref, commit, '']);
      return name;
    } catch (err) {
      if (refExists(ws, ref)) continue;
      throw err;
    }
  }
  throw fail('conflict', `too many branches named ${base}-N`);
}

// `git log -1 --stat` of a branch commit, for the CLI.
export function branchSummary(ws, commit) {
  return git(ws, ['log', '-1', '--stat', '--no-color', commit]).toString('utf8').trimEnd();
}

export function createBranch(store, ws, run, { by = null } = {}) {
  if (!ws?.isGit) throw fail('bad_request', 'A branch needs a git repo; this folder is not one.');
  const info = store.runs().find((r) => r.run === run);
  if (!info) throw fail('not_found', `No run "${run}" with recorded changes.`);
  const label = info.label || info.run;
  const head = gitMaybe(ws, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);

  const files = planFiles(store, ws, run, head);
  const changed = files.filter((f) => !f.conflict && f.end.sha !== f.start.sha);
  const result = files.map((f) => (f.conflict ? { path: f.path, status: 'conflict', reason: f.conflict } : { path: f.path, status: 'applied' }));
  if (!changed.length) {
    const left = files.filter((f) => f.conflict);
    if (left.length) throw fail('conflict', `Nothing could go on a branch: ${left.map((f) => `${f.path} (${f.conflict})`).join('; ')}.`);
    throw fail('conflict', `Nothing to put on a branch: ${label}'s changes are already in HEAD.`);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grapim-branch-'));
  let tree;
  try {
    const env = { GIT_INDEX_FILE: path.join(tmp, 'index') };
    git(ws, head ? ['read-tree', head] : ['read-tree', '--empty'], { env });
    for (const f of changed) {
      if (f.end.sha === null) {
        git(ws, ['update-index', '--force-remove', '--', f.path], { env });
      } else {
        const blob = gitText(ws, ['hash-object', '-w', '--no-filters', '--stdin'], { input: f.end.buf });
        git(ws, ['update-index', '--add', '--cacheinfo', `${f.mode},${blob},${f.path}`], { env });
      }
    }
    tree = gitText(ws, ['write-tree'], { env });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const name = ident(label);
  const env = { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: AGENT_EMAIL, ...committerEnv(ws, name) };
  const commit = gitText(ws, ['commit-tree', tree, ...(head ? ['-p', head] : []), '-F', '-'], { input: message(store, info, label, files), env });
  const branch = makeRef(ws, `grapim/${slug(label)}`, commit, run);

  table(store);
  store.tx(() =>
    store.db
      .prepare(
        `INSERT INTO reviews (run, branch, commit_sha, branch_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(run) DO UPDATE SET branch = excluded.branch, commit_sha = excluded.commit_sha, branch_at = excluded.branch_at`,
      )
      .run(run, branch, commit, store.now()),
  );
  store.recordEvent(run, 'branch', null, `${branch} ${commit.slice(0, 12)}`, by);
  return { branch, commit, files: result };
}
