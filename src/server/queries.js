// Read queries the server needs that src/store.js does not have. They read
// store.db directly and never write.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { rootKey } from '../workspace.js';

const slash = (p) => p.split(path.sep).join('/');

export function lastEventId(store) {
  return store.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM events').get().id;
}

// actor: who did it. Reviews and branches name the run in `agent` and the
// person (or agent) who acted in `actor`; rows from before actors were
// recorded have null there. For every other kind the agent acted itself.
// latest: the newest `limit` events (still oldest first), for feeds that show
// what just happened. Otherwise the `limit` events right after `after`, for paging.
export function eventsAfter(store, after, limit, { latest = false } = {}) {
  const cols = `SELECT e.id, e.ts, e.agent, COALESCE(a.label, e.agent) AS label, e.kind, e.path, e.detail,
              COALESCE(e.actor, CASE WHEN e.kind IN ('review', 'branch') THEN NULL ELSE e.agent END) AS actor
       FROM events e LEFT JOIN agents a ON a.agent = e.agent WHERE e.id > ?`;
  if (latest) return store.db.prepare(`${cols} ORDER BY e.id DESC LIMIT ?`).all(after, limit).reverse();
  return store.db.prepare(`${cols} ORDER BY e.id LIMIT ?`).all(after, limit);
}

// Every recorded change to one file in this worktree, oldest first.
export function fileHistory(store, ws, key) {
  return store.db
    .prepare(
      `SELECT id, ts, run, COALESCE(label, run) AS label, turn, added, removed, before_sha, after_sha
       FROM changes WHERE root_key = ? AND path_key = ? ORDER BY id`,
    )
    .all(rootKey(ws.root), key);
}

// The newest change of each file in this worktree: Map(path_key -> { ts, label, run }).
export function lastChanges(store, ws) {
  const rows = store.db
    .prepare(
      `SELECT path_key, ts, run, COALESCE(label, run) AS label FROM changes
       WHERE id IN (SELECT MAX(id) FROM changes WHERE root_key = ? GROUP BY path_key)`,
    )
    .all(rootKey(ws.root));
  return new Map(rows.map((r) => [r.path_key, { ts: r.ts, label: r.label, run: r.run }]));
}

// The run's intent events, oldest first: what it said it was working on, and when.
export function intentsOf(store, agent) {
  return store.db.prepare(`SELECT ts, detail FROM events WHERE agent = ? AND kind = 'intent' ORDER BY id`).all(agent);
}

// Every worktree of the repo, from git. Outside git, just this folder.
export function worktrees(ws) {
  const self = [{ name: ws.worktree, root: slash(ws.root), branch: null }];
  if (!ws.isGit) return self;
  let out;
  try {
    out = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: ws.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  } catch {
    return self;
  }
  const list = [];
  for (const block of out.split(/\r?\n\r?\n/)) {
    const wt = block.match(/^worktree (.+)$/m)?.[1];
    if (!wt) continue;
    const root = slash(path.resolve(wt));
    list.push({ name: path.basename(root), root, branch: block.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? null });
  }
  return list.length ? list : self;
}
