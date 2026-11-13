// "No code storage" (docs: /docs/data-handling): a team setting, owner only.
//
//   teams.code_storage = 'full'      the default: synced file contents are kept
//                                    in h_blobs and diffs are drawn from them.
//   teams.code_storage = 'metadata'  ingest never writes h_blobs for the team
//                                    (src/hub/ingest.js), `grapim sync` stops
//                                    sending contents (src/sync.js), and a run
//                                    page reads its diff live from GitHub when
//                                    it can, without saving it.
//
// Turning the mode on does not delete what is already stored: that is its own
// owner action, deleteContents, scoped to the team.

import { tx } from './db.js';
import { GitHubClient } from './github/client.js';
import { parseNote } from '../provenance/note.js';

export const CODE_STORAGE = Object.freeze(['full', 'metadata']);
const SHA = /^[0-9a-f]{40}$/;
// Live diffs: at most this many commits read from GitHub per page view, and
// no waiting on a rate limit (the page shows the local-only state instead).
export const MAX_LIVE_COMMITS = 5;

export function codeStorageOf(db, teamId) {
  const row = db.prepare('SELECT code_storage FROM teams WHERE id = ?').get(teamId);
  return row?.code_storage === 'metadata' ? 'metadata' : 'full';
}

export function setCodeStorage(db, teamId, mode) {
  if (!CODE_STORAGE.includes(mode)) throw new Error('bad mode');
  return db.prepare('UPDATE teams SET code_storage = ? WHERE id = ?').run(mode, teamId).changes > 0;
}

// What the hub holds of the team's file contents: { files, bytes }.
export function storedContents(db, teamId) {
  const r = db.prepare('SELECT COUNT(*) AS files, COALESCE(SUM(LENGTH(content)), 0) AS bytes FROM h_blobs WHERE team_id = ?').get(teamId);
  return { files: r.files, bytes: r.bytes };
}

// Deletes every stored file content of one team, and takes their bytes off
// the team's storage count. Returns { files, bytes } deleted.
export function deleteContents(db, teamId) {
  return tx(db, () => {
    const { files, bytes } = storedContents(db, teamId);
    db.prepare('DELETE FROM h_blobs WHERE team_id = ?').run(teamId);
    db.prepare('UPDATE team_usage SET bytes = MAX(0, bytes - ?) WHERE team_id = ?').run(bytes, teamId);
    return { files, bytes };
  });
}

// A GitHub unified patch (one file of GET /repos/:o/:n/commits/:sha) as the
// hunks src/hub/hunks.js makes: [{ oldStart, oldLines, newStart, newLines, lines: [{ t, s }] }].
export function patchHunks(patch) {
  const out = [];
  let cur = null;
  for (const line of String(patch ?? '').split('\n')) {
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h) {
      cur = { oldStart: Number(h[1]), oldLines: h[2] === undefined ? 1 : Number(h[2]), newStart: Number(h[3]), newLines: h[4] === undefined ? 1 : Number(h[4]), lines: [] };
      out.push(cur);
      continue;
    }
    if (!cur || line.startsWith('\\')) continue; // "\ No newline at end of file"
    const t = line[0];
    if (t === '+' || t === '-' || t === ' ') cur.lines.push({ t, s: line.slice(1).replace(/\r$/, '') });
  }
  return out;
}

// The commits whose provenance note names this run, with the files the note
// gives it lines in: [{ sha, paths: Set }], oldest note first.
export function runCommits(db, teamId, repoId, runId, limit = MAX_LIVE_COMMITS) {
  const rows = db
    .prepare('SELECT commit_sha, note_json FROM h_provenance WHERE team_id = ? AND repo_id = ? AND instr(note_json, ?) > 0 ORDER BY received_at LIMIT 200')
    .all(teamId, repoId, JSON.stringify(runId));
  const out = [];
  for (const r of rows) {
    if (out.length >= limit) break;
    let note;
    try {
      note = parseNote(r.note_json);
    } catch {
      continue;
    }
    const i = note.runs.findIndex((x) => x.id === runId);
    if (i < 0) continue;
    const paths = new Set(Object.entries(note.files ?? {}).filter(([, ranges]) => ranges.some((x) => x[2] === i)).map(([p]) => p));
    if (paths.size) out.push({ sha: r.commit_sha, paths });
  }
  return out;
}

// The team's live installation that can read this GitHub repo ("owner/name"), or null.
function installationFor(db, teamId, fullName) {
  const live = 'i.team_id = ? AND i.deleted_at IS NULL AND i.suspended_at IS NULL';
  const byRepo = db
    .prepare(`SELECT i.id FROM gh_installations i JOIN gh_installation_repos r ON r.installation_id = i.id WHERE ${live} AND r.full_name = ? COLLATE NOCASE LIMIT 1`)
    .get(teamId, fullName);
  if (byRepo) return byRepo.id;
  const owner = fullName.split('/')[0];
  return db.prepare(`SELECT i.id FROM gh_installations i WHERE ${live} AND i.account_login = ? COLLATE NOCASE LIMIT 1`).get(teamId, owner)?.id ?? null;
}

// The diff of each wanted file, read from GitHub for the commits that carry
// this run's lines. Nothing is stored. Returns
//   { files: Map(path -> [{ sha, hunks }]) } or { files: Map(), reason } when it cannot.
// github: hub.github (its `auth` makes installation tokens).
export async function liveDiffs({ db, github, team, repo, run, paths }) {
  const none = (reason) => ({ files: new Map(), reason });
  if (!github?.auth) return none('no_app');
  if (!repo.github || !/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(repo.github)) return none('no_github_repo');
  const commits = runCommits(db, team.id, repo.id, run).filter((c) => SHA.test(c.sha));
  if (!commits.length) return none('no_commits');
  const inst = installationFor(db, team.id, repo.github);
  if (!inst) return none('not_linked');
  const want = new Set(paths);
  const files = new Map();
  try {
    const token = await github.auth.installationToken(inst);
    const gh = new GitHubClient({ apiBase: github.auth.apiBase, token, fetch: github.auth.fetch, maxWaitMs: 0, sleep: async () => {} });
    const [owner, name] = repo.github.split('/');
    for (const c of commits) {
      if (![...c.paths].some((p) => want.has(p))) continue;
      const data = await gh.rest('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commits/${c.sha}`);
      for (const f of Array.isArray(data?.files) ? data.files : []) {
        if (typeof f?.filename !== 'string' || !want.has(f.filename) || !c.paths.has(f.filename) || typeof f.patch !== 'string') continue;
        if (!files.has(f.filename)) files.set(f.filename, []);
        files.get(f.filename).push({ sha: c.sha, hunks: patchHunks(f.patch) });
      }
    }
  } catch {
    // GitHub unreachable, rate limited, or the App lost access: fall back.
    return none('github_error');
  }
  return { files };
}
