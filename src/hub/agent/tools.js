// Ask Grapim's tools. Each one runs as the signed-in person, in their team,
// with their role, and reuses the read functions behind the hub's own pages
// (read.js, overview.js, the reports, the workspace engine), so the model can
// see exactly what the person could open in the hub and nothing more.
//
// Read tools answer with data. Action tools never write: they validate the
// request, check the person may do it, and store a proposal that the panel
// shows as a card. The write happens only when the person clicks Confirm,
// through the same CSRF-checked route as the page's own button.
//
// What never reaches the model: token and invite values, token hints,
// storage or connector credentials, another team's rows, and files that
// usually hold secrets (see SECRET_FILE).

import { replay, isTracked } from '../../attribution.js';
import { snapshot } from '../../ledger.js';
import { runDetail, listRuns, resolveRun } from '../../server/runs.js';
import { fileHistory } from '../../server/queries.js';
import { resolvePath } from '../../server/paths.js';
import { HttpError } from '../http.js';
import { cleanWorkspaceName } from '../workspaces.js';
import { REPORTS } from '../reports/index.js';
import { splitLines } from '../../diff.js';

export const RESULT_CHARS = 24_000; // one tool result, at most
const DIFF_FILE_CHARS = 4_000; // diff text per file in get_run
const DIFF_TOTAL_CHARS = 16_000;
export const FILE_BYTES = 64 * 1024; // read_workspace_file
const BLOB_BUDGET = 4 * 1024 * 1024; // file_history's line blame on synced content
const LIST_MAX = 300;

// Files that usually hold credentials: never read into the conversation.
export const SECRET_FILE = /(^|\/)(\.env(\..*)?|\.envrc|\.npmrc|\.pypirc|\.netrc|\.git-credentials|credentials(\.json)?|secrets?\.(json|ya?ml|toml)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|[^/]*\.(pem|key|p12|pfx|keystore|jks))$/i;

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });

const REPO_ID = str('The repo id (40 hex characters) from list_repos_and_workspaces, a run list, or the page context.');
const WORKSPACE = str('The workspace name or id.');

// The tool list never changes during a conversation (a changed list would
// invalidate the cache and the model's earlier reasoning).
export const TOOLS = [
  {
    name: 'list_runs_to_review',
    description: 'Agent runs synced to the hub that still need a hub review (pending, or approved before the run changed), newest first. Each says who synced it ("mine": the signed-in person synced it, so they cannot review it themselves).',
    input_schema: obj({ repo_id: { ...REPO_ID, description: 'Only this repo. Leave out for every repo.' } }),
  },
  {
    name: 'get_run',
    description: 'One synced agent run: its intent per turn, the files it changed with line counts, whether its lines are still in the tree, its review, and the diff text (long diffs are cut).',
    input_schema: obj({ repo_id: REPO_ID, run: str('The run id, or a unique prefix or label.'), machine: str('The machine, when the same run id exists on several machines.') }, ['repo_id', 'run']),
  },
  {
    name: 'file_history',
    description: 'Who (which agent run, on which machine) changed a file, newest first. With line, also who wrote that line in the newest version. Works on a synced repo (repo_id) or a cloud workspace (workspace).',
    input_schema: obj({ repo_id: REPO_ID, workspace: WORKSPACE, path: str('The file path, relative to the repo root, like src/app.ts.'), line: { type: 'integer', minimum: 1, description: 'A 1-based line number.' } }, ['path']),
  },
  {
    name: 'get_report',
    description: 'A team report: ai-share (the AI share of added lines), agents (lines per agent kind), unreviewed (AI lines merged without review) or activity. Teams without the Governance plan get last week\'s AI share only.',
    input_schema: obj({ report: { type: 'string', enum: [...REPORTS] }, repo_id: { ...REPO_ID, description: 'Only this repo.' }, from: str('First day, YYYY-MM-DD. Default: 12 weeks ago.'), to: str('Last day, YYYY-MM-DD. Default: today.') }, ['report']),
  },
  { name: 'failing_pull_requests', description: 'Open GitHub pull requests that contain agent runs without a fresh hub approval, and whether the Grapim check fails them (the team requires review).', input_schema: obj({}) },
  { name: 'active_agents', description: 'Agents seen in the last hour that have not ended, across the team\'s synced repos.', input_schema: obj({}) },
  { name: 'list_repos_and_workspaces', description: 'The team\'s synced repos (with ids) and cloud workspaces.', input_schema: obj({}) },
  { name: 'get_team', description: 'The team: plan, limits, review policy, linked GitHub accounts, members and roles, and machine token names (never their values). Members see their own tokens; owners see all.', input_schema: obj({}) },
  {
    name: 'get_workspace',
    description: 'A cloud workspace: its address, its token names and access (never their values), and its newest runs.',
    input_schema: obj({ workspace: WORKSPACE }, ['workspace']),
  },
  {
    name: 'get_workspace_run',
    description: 'One run in a cloud workspace: its turns, files and diff text (long diffs are cut).',
    input_schema: obj({ workspace: WORKSPACE, run: str('The run id, or a unique prefix or label.') }, ['workspace', 'run']),
  },
  {
    name: 'list_workspace_files',
    description: `Files in a cloud workspace (at most ${LIST_MAX}), with size and the last run that changed each.`,
    input_schema: obj({ workspace: WORKSPACE, path: str('A folder, like notes/. Leave out for the whole workspace.') }, ['workspace']),
  },
  {
    name: 'read_workspace_file',
    description: `The text of one file in a cloud workspace (the first ${FILE_BYTES / 1024} KB). Files that usually hold secrets (.env, keys, credentials) are refused.`,
    input_schema: obj({ workspace: WORKSPACE, path: str('The file path, like notes/plan.md.') }, ['workspace', 'path']),
  },
  {
    name: 'propose_review_decision',
    description: 'Propose approving or rejecting a synced run in the hub. This does not record anything: the person sees a card and must click Confirm. The person who synced a run cannot review it.',
    input_schema: obj({ repo_id: REPO_ID, run: str('The run id.'), machine: str('The machine, when needed.'), decision: { type: 'string', enum: ['approved', 'rejected'] }, note: str('An optional review note, at most 1000 characters.') }, ['repo_id', 'run', 'decision']),
  },
  {
    name: 'propose_undo_workspace_run',
    description: 'Propose undoing a run in a cloud workspace (its files go back; the undo is itself a run that can be undone). Nothing changes until the person clicks Confirm.',
    input_schema: obj({ workspace: WORKSPACE, run: str('The run id, or a unique prefix or label.') }, ['workspace', 'run']),
  },
  { name: 'propose_invite_link', description: 'Propose creating a team invite link (owners only). The link is shown only to the person after they confirm, never to you.', input_schema: obj({}) },
  {
    name: 'propose_workspace_token',
    description: 'Propose creating a token for a cloud workspace, for an agent. The token is shown only to the person after they confirm, never to you.',
    input_schema: obj({ workspace: WORKSPACE, name: str('1 to 40 letters, digits, dots, dashes or underscores; it prefixes the agent names in the ledger.'), access: { type: 'string', enum: ['read', 'write'] } }, ['workspace', 'name', 'access']),
  },
  {
    name: 'propose_rename_workspace',
    description: 'Propose renaming a cloud workspace. Its address changes; tokens keep working.',
    input_schema: obj({ workspace: WORKSPACE, new_name: str('Lowercase letters, digits and dashes.') }, ['workspace', 'new_name']),
  },
];

export const ACTION_TOOLS = new Set(TOOLS.filter((t) => t.name.startsWith('propose_')).map((t) => t.name));

// What the panel says while a tool runs (the summary after comes from the tool).
export const RUNNING = {
  list_runs_to_review: 'Looking for runs to approve',
  get_run: 'Reading the run',
  file_history: 'Looking at the file history',
  get_report: 'Reading the report',
  failing_pull_requests: 'Checking pull requests',
  active_agents: 'Looking for active agents',
  list_repos_and_workspaces: 'Listing repos and workspaces',
  get_team: 'Reading the team',
  get_workspace: 'Opening the workspace',
  get_workspace_run: 'Reading the workspace run',
  list_workspace_files: 'Listing files',
  read_workspace_file: 'Reading a file',
  propose_review_decision: 'Preparing a review',
  propose_undo_workspace_run: 'Preparing an undo',
  propose_invite_link: 'Preparing an invite link',
  propose_workspace_token: 'Preparing a token',
  propose_rename_workspace: 'Preparing a rename',
};

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const fail = (message) => {
  throw new HttpError(400, 'tool_input', message);
};
const text = (v, name, max = 200) => {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || v.length > max) fail(`${name} must be a string of at most ${max} characters.`);
  return v;
};
const need = (v, name, max) => text(v, name, max) ?? fail(`${name} is required.`);

// A diff in the unified format, cut at `max` characters.
function diffText(hunks, max) {
  if (!hunks?.length) return '';
  let out = '';
  for (const h of hunks) {
    out += `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n`;
    for (const l of h.lines) out += `${l.t}${l.s}\n`;
    if (out.length > max) return `${out.slice(0, max)}\n[diff cut here]`;
  }
  return out;
}

function withDiffs(files) {
  let left = DIFF_TOTAL_CHARS;
  return files.map((f) => {
    const d = f.diff ? diffText(f.diff.hunks, Math.min(DIFF_FILE_CHARS, Math.max(0, left))) : null;
    if (d) left -= d.length;
    return { path: f.path, added: f.added, removed: f.removed, state: f.state, untracked: !!f.untracked, diff: f.diff ? (d || '[not shown: the diff budget for this answer is used up]') : null };
  });
}

export function createTools(hub) {
  const { db, read, teams, workspaces } = hub;
  const hubPath = (team, rest = '') => `/hub/teams/${team.id}${rest}`;
  const runUrl = (team, repoId, run, machine) => hubPath(team, `/repos/${repoId}/runs/${encodeURIComponent(run)}${machine ? `?machine=${encodeURIComponent(machine)}` : ''}`);

  function repoOf(team, id) {
    const repo = typeof id === 'string' ? read.repo(team, id) : null;
    if (!repo) fail('No repo with that id in this team. list_repos_and_workspaces lists them.');
    return repo;
  }

  function workspaceOf(team, ref) {
    const r = need(ref, 'workspace', 80);
    const ws = workspaces.live(team.id).find((w) => w.id === r || w.name === r.toLowerCase());
    if (!ws) fail('No workspace with that name or id in this team.');
    return ws;
  }

  // The workspace's engine, held open while fn runs.
  async function engineOf(ws, fn) {
    const engine = hub.mount.engineFor(ws);
    return engine.use(() => fn(engine));
  }

  const readLimit = (s) => hub.limit({}, 'read', s.userId);

  // ---- read tools ----

  const read_ = {
    list_runs_to_review(s, input) {
      const only = input.repo_id ? repoOf(s.team, input.repo_id).id : null;
      const runs = hub.overview.runs(s.team, s.userId).filter((r) => r.waiting && (!only || r.repo_id === only));
      return {
        summary: `Looked at ${plural(runs.length, 'run')} waiting for approval`,
        data: {
          count: runs.length,
          runs: runs.slice(0, 40).map((r) => ({
            repo: r.repo, repo_id: r.repo_id, run: r.run, machine: r.machine, label: r.label, kind: r.kind, intent: r.intent ?? null,
            files: r.files, added: r.added, removed: r.removed, last_change: new Date(r.last_ts).toISOString(), status: r.status, mine: r.mine,
            url: runUrl(s.team, r.repo_id, r.run, r.machine),
          })),
        },
      };
    },

    get_run(s, input) {
      readLimit(s);
      const repo = repoOf(s.team, input.repo_id);
      const d = read.run(s.team, repo, need(input.run, 'run', 200), text(input.machine, 'machine', 100));
      const r = d.run;
      const review = hub.github?.reviewPanel?.({ team: s.team, repo, run: r.run, userId: s.userId }) ?? null;
      return {
        summary: `Read ${r.label}: ${plural(d.files.length, 'file')}`,
        data: {
          repo: repo.name, repo_id: repo.id, run: r.run, label: r.label, machine: r.machine, worktree: r.worktree,
          turns: d.turns.map((t) => ({ turn: t.turn, intent: t.intent, files: t.files })),
          totals: { files: r.files, added: r.added, removed: r.removed }, in_tree: r.in_tree, active: r.active,
          first_change: new Date(r.first_ts).toISOString(), last_change: new Date(r.last_ts).toISOString(),
          review: review
            ? { status: review.hub ? (review.hub.stale ? 'stale' : review.hub.status) : 'pending', by: review.hub?.reviewer_login ?? null, note: review.hub?.note ?? null, synced_by: review.owners, you_synced_it: review.mine, policy_requires_review: review.enforced, pull_requests: review.pulls.map((p) => `${p.owner}/${p.name}#${p.number}`) }
            : null,
          files: withDiffs(d.files),
          url: runUrl(s.team, repo.id, r.run, r.machine),
        },
      };
    },

    async file_history(s, input) {
      readLimit(s);
      const p = need(input.path, 'path', 500);
      const line = input.line === undefined || input.line === null ? null : Number(input.line);
      if (line !== null && !(Number.isInteger(line) && line >= 1)) fail('line must be a whole number, 1 or more.');
      if (input.workspace) return workspaceFileHistory(s, workspaceOf(s.team, input.workspace), p, line);
      const repo = repoOf(s.team, input.repo_id);
      const rows = db
        .prepare(
          `SELECT c.machine, c.worktree, c.local_id, c.run, COALESCE(a.label, c.label, c.run) AS label, c.turn, c.added, c.removed, c.ts, c.before_sha, c.after_sha, c.untracked
           FROM h_changes c LEFT JOIN h_agents a ON a.team_id = c.team_id AND a.repo_id = c.repo_id AND a.machine = c.machine AND a.agent = c.run
           WHERE c.team_id = ? AND c.repo_id = ? AND c.path = ? AND c.ts >= ? ORDER BY c.ts DESC, c.id DESC LIMIT 500`,
        )
        .all(s.team.id, repo.id, p, read.cutoff(s.team));
      const data = {
        repo: repo.name, path: p,
        changes: rows.slice(0, 60).map((c) => ({ run: c.run, label: c.label, machine: c.machine, worktree: c.worktree, turn: c.turn, added: c.added, removed: c.removed, at: new Date(c.ts).toISOString(), url: runUrl(s.team, repo.id, c.run, c.machine) })),
        runs: [...new Set(rows.map((c) => c.label))],
      };
      if (line !== null && rows.length) data.line = blameSynced(s.team, rows, line);
      return { summary: `Looked at ${plural(rows.length, 'change')} to ${p.split('/').pop()}`, data };
    },

    get_report(s, input) {
      readLimit(s);
      const name = REPORTS.includes(input.report) ? input.report : fail(`report must be one of ${REPORTS.join(', ')}.`);
      const team = teams.get(s.team.id) ?? s.team;
      const q = new URLSearchParams();
      if (input.repo_id) q.set('repo', repoOf(team, input.repo_id).id);
      if (input.from) q.set('from', need(input.from, 'from', 10));
      if (input.to) q.set('to', need(input.to, 'to', 10));
      try {
        const r = hub.reports.get(team, name, hub.reports.params(team, q));
        return { summary: `Read the ${name} report`, data: { ...r, url: hubPath(team, `/reports/${name}`) } };
      } catch (err) {
        if (err instanceof HttpError && err.status === 402) {
          return { summary: 'Read last week\'s AI share', data: { plan_required: 'Reports are on the Governance plan. This is last week\'s AI share only.', teaser: hub.reports.teaser(team), url: hubPath(team, '/reports') } };
        }
        throw err;
      }
    },

    failing_pull_requests(s) {
      const p = hub.overview.pulls(teams.get(s.team.id) ?? s.team);
      const list = p.list.map((x) => ({ pull: `${x.owner}/${x.name}#${x.number}`, url: x.url, runs: x.runs, unapproved_runs: x.unapproved, check_fails: x.failing, updated: new Date(x.updated_at).toISOString() }));
      return { summary: `Checked ${plural(list.length, 'pull request')}`, data: { review_required_by_policy: p.enforced, pull_requests: list } };
    },

    active_agents(s) {
      const list = hub.overview.activeAgents(s.team);
      return {
        summary: `Found ${plural(list.length, 'active agent')}`,
        data: list.map((a) => ({ label: a.label, kind: a.kind, repo: a.repo, repo_id: a.repo_id, machine: a.machine, worktree: a.worktree, intent: a.intent, last_seen: new Date(a.last_seen).toISOString() })),
      };
    },

    list_repos_and_workspaces(s) {
      const repos = read.repos(s.team);
      const ws = hub.overview.workspaces(s.team);
      return {
        summary: `Listed ${plural(repos.length, 'repo')} and ${plural(ws.length, 'workspace')}`,
        data: {
          repos: repos.map((r) => ({ id: r.id, name: r.name, machines: r.machines, runs_in_history: r.runs, last_sync: r.last_sync_at ? new Date(r.last_sync_at).toISOString() : null, url: hubPath(s.team, `/repos/${r.id}`) })),
          workspaces: ws.map((w) => ({ id: w.id, name: w.name, created: new Date(w.created_at).toISOString(), last_activity: new Date(w.last_activity).toISOString(), url: hubPath(s.team, `/workspaces/${w.id}`), desk: `/w/${s.team.id}/${w.name}/` })),
        },
      };
    },

    get_team(s) {
      const team = teams.get(s.team.id) ?? s.team;
      const l = hub.limits(team);
      const fin = (n) => (Number.isFinite(n) ? n : 'unlimited');
      const owner = s.role === 'owner';
      const policy = hub.github?.policy?.(team.id) ?? null;
      let github = [];
      try {
        github = hub.github?.installs?.forTeam(team.id).map((i) => i.account_login) ?? [];
      } catch {}
      return {
        summary: 'Read the team',
        data: {
          team: { id: team.id, name: team.name, plan: team.plan },
          you: { login: s.login, role: s.role },
          seats: { used: teams.seatsUsed(team.id), limit: fin(l.seats) },
          limits: { history_days: fin(l.historyDays), repos: fin(l.repos), workspaces: fin(l.workspaces) },
          features: l.features,
          review_policy: policy ? { require_review: !!policy.require_review, require_provenance: !!policy.require_provenance, enforced: !!hub.github?.requireReview?.(team) } : null,
          github_accounts: github,
          members: teams.members(team.id).map((m) => ({ login: m.login, name: m.name, role: m.role, joined: new Date(m.joined_at).toISOString() })),
          machine_tokens: teams.tokens(team.id, { role: s.role, userId: s.userId }).map((t) => ({ name: t.name, owner: t.owner, created: new Date(t.created_at).toISOString(), last_used: t.last_used_at ? new Date(t.last_used_at).toISOString() : null })),
          ...(owner ? { open_invites: teams.invites(team.id).length } : {}),
          url: hubPath(team, '/settings'),
        },
      };
    },

    async get_workspace(s, input) {
      const ws = workspaceOf(s.team, input.workspace);
      const tokens = workspaces.tokens(ws, { role: s.role, userId: s.userId }).map((t) => ({ name: t.name, access: t.scope, folders: t.scopes, owner: t.owner, created: new Date(t.created_at).toISOString(), last_used: t.last_used_at ? new Date(t.last_used_at).toISOString() : null }));
      const runs = await engineOf(ws, async (e) => (e.ctx.offload ? e.ctx.offload.runs(e.store) : listRuns(e.store)));
      return {
        summary: `Opened ${ws.name}: ${plural(runs.length, 'run')}`,
        data: {
          id: ws.id, name: ws.name, created: new Date(ws.created_at).toISOString(), url: hubPath(s.team, `/workspaces/${ws.id}`), desk: `/w/${s.team.id}/${ws.name}/`,
          tokens,
          runs: runs.slice(0, 25).map((r) => ({ run: r.run, label: r.label, intent: r.intent, files: r.files, added: r.added, removed: r.removed, in_tree: r.in_tree, review: r.review?.status ?? 'pending', last_change: new Date(r.last_ts).toISOString() })),
        },
      };
    },

    async get_workspace_run(s, input) {
      const ws = workspaceOf(s.team, input.workspace);
      const q = need(input.run, 'run', 200);
      const d = await engineOf(ws, async (e) => {
        const id = resolveRun(e.store, q).run;
        return e.ctx.offload ? e.ctx.offload.runDetail(e.store, id) : runDetail(e.store, id);
      });
      return {
        summary: `Read ${d.run.label}: ${plural(d.files.length, 'file')}`,
        data: { workspace: ws.name, run: d.run.run, label: d.run.label, intent: d.run.intent, review: d.run.review?.status ?? 'pending', in_tree: d.run.in_tree, turns: d.turns, files: withDiffs(d.files), desk: `/w/${s.team.id}/${ws.name}/` },
      };
    },

    async list_workspace_files(s, input) {
      const ws = workspaceOf(s.team, input.workspace);
      const dir = text(input.path, 'path', 500) ?? '';
      const all = await engineOf(ws, async (e) => e.ctx.workspace.listAll(dir, { max: LIST_MAX }));
      return {
        summary: `Listed ${plural(all.files.length, 'file')} in ${ws.name}`,
        data: { workspace: ws.name, truncated: all.truncated, files: all.files.map((f) => ({ path: f.path, size: f.size, last_change: f.last_change ? { label: f.last_change.label, at: new Date(f.last_change.ts).toISOString() } : null, held_by: f.held_by })) },
      };
    },

    async read_workspace_file(s, input) {
      const ws = workspaceOf(s.team, input.workspace);
      const p = need(input.path, 'path', 500);
      if (SECRET_FILE.test(p)) fail(`${p} usually holds secrets, so Ask Grapim does not read it. Open it in the review desk instead.`);
      return engineOf(ws, async (e) => {
        const t = resolvePath(e.ws, p);
        if (!t.file || t.dir) fail(`${p} is a folder.`);
        const now = snapshot(t.abs);
        if (now.sha === null) fail(`${p} does not exist in ${ws.name}.`);
        if (!now.buf) return { summary: `Skipped ${p.split('/').pop()} (binary or large)`, data: { path: p, text: null, note: 'Binary, or over 2 MB: not shown.' } };
        const cut = now.buf.length > FILE_BYTES;
        return {
          summary: `Read ${p.split('/').pop()}`,
          data: { workspace: ws.name, path: p, bytes: now.buf.length, truncated: cut, text: now.buf.subarray(0, FILE_BYTES).toString('utf8') },
        };
      });
    },
  };

  // Who wrote `line` in the newest synced version, by replaying the file's
  // changes on its newest machine and worktree (read.js does the same per run).
  function blameSynced(team, rowsNewestFirst, line) {
    const top = rowsNewestFirst[0];
    const rows = rowsNewestFirst.filter((c) => c.machine === top.machine && c.worktree === top.worktree).reverse();
    const get = db.prepare('SELECT content FROM h_blobs WHERE team_id = ? AND sha = ?');
    let left = BLOB_BUDGET;
    const cache = new Map();
    const blob = (sha) => {
      if (sha === null) return null;
      if (cache.has(sha)) return cache.get(sha);
      const row = sha === 'untracked' ? undefined : get.get(team.id, sha);
      const buf = row ? Buffer.from(row.content) : undefined;
      if (buf && buf.length > left) return undefined;
      if (buf) left -= buf.length;
      cache.set(sha, buf);
      return buf;
    };
    const changes = rows.map((c) => ({ ...c, before: blob(c.before_sha), after: blob(c.after_sha) }));
    const last = changes[changes.length - 1];
    const now = { sha: last.after_sha, buf: last.after ?? null };
    if (!isTracked(changes, now)) return { line, known: false, note: 'The content was not kept (binary, over 2 MB, or not synced), so lines cannot be attributed.' };
    const r = replay(changes, now);
    if (line > r.lines.length) return { line, known: false, note: `The newest version has ${r.lines.length} lines.` };
    const who = r.who[line - 1];
    return {
      line,
      known: true,
      text: Buffer.from(r.lines[line - 1], 'latin1').toString('utf8').replace(/\r?\n$/, ''),
      written_by: who ? { run: who.run, label: who.label, turn: who.turn } : who === null ? 'there before the first recorded change' : 'outside agents',
      machine: top.machine,
    };
  }

  async function workspaceFileHistory(s, ws, p, line) {
    return engineOf(ws, async (e) => {
      const t = resolvePath(e.ws, p);
      if (!t.file || t.dir) fail(`${p} is a folder.`);
      const rows = fileHistory(e.store, e.ws, t.file.key).reverse();
      const data = { workspace: ws.name, path: p, changes: rows.slice(0, 60).map((c) => ({ run: c.run, label: c.label, turn: c.turn, added: c.added, removed: c.removed, at: new Date(c.ts).toISOString() })) };
      if (line !== null) {
        const b = e.ctx.offload ? await e.ctx.offload.blame(e.store, e.ws, t.file) : null;
        if (b && !b.untracked) {
          const hit = b.lines.find((x) => x.line === line);
          data.line = hit ? { line, text: hit.text, written_by: hit.run ? { run: hit.run, label: hit.label, turn: hit.turn } : 'outside agents' } : { line, written_by: 'unchanged since the workspace\'s last commit' };
        } else data.line = { line, known: false };
      }
      return { summary: `Looked at ${plural(rows.length, 'change')} to ${p.split('/').pop()}`, data };
    });
  }

  // ---- action tools: validate, check, and describe; never write ----

  const act = {
    propose_review_decision(s, input) {
      const repo = repoOf(s.team, input.repo_id);
      const decision = input.decision === 'approved' || input.decision === 'rejected' ? input.decision : fail('decision must be approved or rejected.');
      const note = text(input.note, 'note', 1000);
      const d = read.run(s.team, repo, need(input.run, 'run', 200), text(input.machine, 'machine', 100));
      const r = d.run;
      if (hub.github?.reviews?.owners(s.team, r.run).has(s.userId)) fail('The signed-in person synced this run, so someone else in the team has to approve it.');
      const verb = decision === 'approved' ? 'Approve' : 'Reject';
      const form = { status: decision, machine: r.machine, ...(note ? { note } : {}) };
      return {
        kind: 'review',
        card: {
          title: `${verb} ${r.label}`,
          verb,
          danger: decision === 'rejected',
          effect: decision === 'approved' ? 'Records your approval in the hub. Open pull requests with this run are checked again.' : 'Records your rejection in the hub. Nothing in the code changes; the run stays until someone undoes it.',
          lines: [['Run', r.intent || r.label], ['Repo', repo.name], ['Machine', r.machine], ['Files', `${r.files} (+${r.added} -${r.removed})`], ...(note ? [['Note', note]] : []), ['As', `@${s.login}`]],
          request: { method: 'POST', url: `${runUrl(s.team, repo.id, r.run).split('?')[0]}/decision`, form, expect: { done: decision } },
          link: { href: runUrl(s.team, repo.id, r.run, r.machine), label: 'Open the run' },
        },
        summary: `Prepared: ${verb.toLowerCase()} ${r.label}`,
      };
    },

    async propose_undo_workspace_run(s, input) {
      const ws = workspaceOf(s.team, input.workspace);
      const q = need(input.run, 'run', 200);
      const info = await engineOf(ws, async (e) => {
        const r = resolveRun(e.store, q);
        const files = [...new Set(e.store.changesOfRun(r.run).map((c) => c.path))];
        return { run: r.run, label: r.label ?? r.run, files };
      });
      if (!info.files.length) fail('That run changed no files.');
      return {
        kind: 'undo',
        card: {
          title: `Undo ${info.label} in ${ws.name}`,
          verb: 'Undo run',
          danger: true,
          effect: `Puts back the ${plural(info.files.length, 'file')} this run changed, keeping later edits by others. The undo is a new run, so it can be undone too.`,
          lines: [['Workspace', ws.name], ['Run', info.label], ['Files', info.files.slice(0, 6).join(', ') + (info.files.length > 6 ? ` and ${info.files.length - 6} more` : '')], ['As', `@${s.login}`]],
          request: { method: 'POST', url: `/w/${s.team.id}/${ws.name}/api/runs/${encodeURIComponent(info.run)}/undo`, json: { turn: null, apply: true }, csrfHeader: true },
          link: { href: `/w/${s.team.id}/${ws.name}/`, label: 'Open the review desk' },
        },
        summary: `Prepared: undo ${info.label}`,
      };
    },

    propose_invite_link(s) {
      if (s.role !== 'owner') fail('Only a team owner can create invite links. Ask an owner.');
      return {
        kind: 'invite',
        card: {
          title: 'Create an invite link',
          verb: 'Create link',
          effect: 'Creates a link anyone can use once, within 7 days, to join as a member. It is shown here only to you.',
          lines: [['Team', s.team.name], ['Joins as', 'member'], ['Seats used', String(teams.seatsUsed(s.team.id))], ['As', `@${s.login}`]],
          request: { method: 'POST', url: hubPath(s.team, '/invites'), form: {}, reveal: true },
          link: { href: hubPath(s.team, '/settings/members'), label: 'Members' },
        },
        summary: 'Prepared an invite link',
      };
    },

    propose_workspace_token(s, input) {
      const ws = workspaceOf(s.team, input.workspace);
      const name = need(input.name, 'name', 40).trim();
      if (!/^[A-Za-z0-9._-]{1,40}$/.test(name)) fail('Name the token with 1 to 40 letters, digits, dots, dashes or underscores.');
      const access = input.access === 'read' || input.access === 'write' ? input.access : fail('access must be read or write.');
      if (db.prepare('SELECT 1 FROM workspace_tokens WHERE workspace_id = ? AND name = ?').get(ws.id, name)) fail(`A token named ${name} exists or existed in ${ws.name}. Pick another name.`);
      return {
        kind: 'workspace_token',
        card: {
          title: `Create a ${access} token for ${ws.name}`,
          verb: 'Create token',
          effect: `An agent with this token can ${access === 'write' ? 'read and write' : 'read'} every file in ${ws.name}. It is shown here once, only to you.`,
          lines: [['Workspace', ws.name], ['Name', name], ['Access', access], ['As', `@${s.login}`]],
          request: { method: 'POST', url: hubPath(s.team, `/workspaces/${ws.id}/tokens`), form: { name, scope: access, from: 'tokens' }, reveal: true },
          link: { href: hubPath(s.team, `/workspaces/${ws.id}/tokens`), label: 'Workspace tokens' },
        },
        summary: `Prepared a ${access} token for ${ws.name}`,
      };
    },

    propose_rename_workspace(s, input) {
      const ws = workspaceOf(s.team, input.workspace);
      const name = cleanWorkspaceName(need(input.new_name, 'new_name', 80));
      if (name === ws.name) fail(`The workspace is already called ${name}.`);
      if (workspaces.byName(s.team.id, name)) fail(`This team already has a workspace named ${name}.`);
      return {
        kind: 'rename',
        card: {
          title: `Rename ${ws.name} to ${name}`,
          verb: 'Rename',
          effect: `The workspace's address becomes /w/${s.team.id}/${name}/. Its files, history and tokens stay; agents using the old address need the new one.`,
          lines: [['Workspace', ws.name], ['New name', name], ['As', `@${s.login}`]],
          request: { method: 'POST', url: hubPath(s.team, `/workspaces/${ws.id}/rename`), form: { name } },
          link: { href: hubPath(s.team, `/workspaces/${ws.id}`), label: 'Open the workspace' },
        },
        summary: `Prepared: rename ${ws.name}`,
      };
    },
  };

  // Runs one tool call. s: { team, role, userId, login }. Returns
  // { ok, summary, data } for reads and { ok, summary, kind, card } for proposals.
  async function run(name, input, s) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || input.__invalid_json) return { ok: false, summary: 'Could not read the request', error: 'The tool input was not valid JSON.' };
    // Membership and role are read again on every call: a person removed
    // from the team, or demoted, mid-conversation loses access at once.
    const mem = teams.membership(s.team.id, s.userId);
    if (!mem) return { ok: false, summary: 'Not allowed', error: 'You are no longer a member of this team.' };
    const now = { ...s, team: mem.team, role: mem.role };
    try {
      if (read_[name]) return { ok: true, ...(await read_[name](now, input)) };
      if (act[name]) return { ok: true, proposal: true, ...(await act[name](now, input)) };
      return { ok: false, summary: 'Unknown tool', error: `There is no tool named ${name}.` };
    } catch (err) {
      const known = err instanceof HttpError || typeof err?.status === 'number' || err?.code === 'bad_request';
      if (!known) hub.log(`agent tool ${name}: ${err?.name ?? 'Error'}`);
      return { ok: false, summary: `${RUNNING[name] ?? name}: failed`, error: known ? err.message : 'That did not work on the hub.' };
    }
  }

  return { run, tools: TOOLS };
}

// The tool result text the model reads: data, never instructions.
export function resultText(data) {
  let s = JSON.stringify(data);
  if (s.length > RESULT_CHARS) s = `${s.slice(0, RESULT_CHARS)} [cut: the answer was longer than ${RESULT_CHARS} characters]`;
  return s;
}
