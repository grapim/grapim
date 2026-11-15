// Grapim Review in the cloud: the GitHub App reviews a team's pull requests
// itself, on Grapim's own model account, with nothing to set up in CI.
//
// A team owner turns it on in Settings, GitHub. From then on every pull
// request event the App receives for that team (opened, new commits,
// reopened, ready for review) queues one job:
//
//   the month's credit left? -> "Grapim Review (cloud)" check, in progress
//   -> fetch the base branch, the PR head and refs/notes/grapim into a
//   temporary folder with the installation token (sent as a header, never
//   in a URL or argv) -> run the review engine in a child process
//   (cloud-review-worker.js) with the model key in its env only -> one
//   pull request review with inline comments, one summary comment (its own
//   marker, so it never overwrites the Action's) -> the check completes
//   -> the folder is deleted, the cost is added to the month.
//
// A deep review on Claude Fable 5.2 can take many minutes, so a job may run
// up to JOB_MS (30 minutes) and the check says so while it runs.
//
// env:
//   GRAPIM_REVIEW_ANTHROPIC_KEY   the key cloud reviews use (else ANTHROPIC_API_KEY)
//   GRAPIM_REVIEW_MODEL           default claude-fable-5-2
//   GRAPIM_REVIEW_MONTHLY_CREDIT  JSON { plan: dollars }, e.g. {"free":10,"team":100}
//   GRAPIM_REVIEW_PRICE           JSON { input, output } dollars per million tokens
//   GRAPIM_REVIEW_JOB_MS          per review, 60000..3600000
//   GRAPIM_REVIEW_CONCURRENCY     reviews at once on this hub, 1..8

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closingIssues } from '../../airev/index.js';
import { md } from '../../provenance/render.js';
import { counts, countText, diffLines, MARKER, statedRequest, summaryMarkdown, toComment } from '../../../action/review/index.mjs';
import { csrfField } from '../pages/layout.js';
import { html } from '../pages/html.js';
import { GitHubClient } from './client.js';
import { JobQueue } from './queue.js';

export const CLOUD_CHECK = 'Grapim Review (cloud)';
export const CLOUD_MARKER = '<!-- grapim:review:cloud -->';
const INLINE_MARKER = '<!-- grapim:review:cloud:inline -->';
export const DEFAULT_MODEL = 'claude-fable-5-2';
const MODEL_NAMES = { 'claude-fable-5-2': 'Claude Fable 5.2', 'claude-opus-5-5': 'Claude Opus 5.5', 'claude-sonnet-5-5': 'Claude Sonnet 5.5' };
// Dollars per million tokens. The engine counts cache reads and writes as
// input, so a review is billed to the credit at the input price at most.
export const PRICES = Object.freeze({
  'claude-fable-5-2': Object.freeze({ input: 8, output: 40 }),
  'claude-opus-5-5': Object.freeze({ input: 4, output: 20 }),
  'claude-sonnet-5-5': Object.freeze({ input: 2, output: 10 }),
});
// Dollars of review per month, by plan. A Fable 5.2 review of a typical pull
// request costs about $0.50 to $2.
export const DEFAULT_CREDIT = Object.freeze({ free: 10, team: 100, governance: 300, enterprise: 1000 });
export const JOB_MS = 30 * 60 * 1000;
const MICROS = 1_000_000;
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;
const WORKER = fileURLToPath(new URL('./cloud-review-worker.js', import.meta.url));
const LIMIT = 64_000;

export const CLOUD_SCHEMA = `
-- Cloud review on or off, per team (owners).
CREATE TABLE IF NOT EXISTS cloud_review_settings (
  team_id     TEXT PRIMARY KEY,
  enabled     INTEGER NOT NULL DEFAULT 0,
  updated_by  TEXT,
  updated_at  INTEGER
);
-- One row per cloud review: what it reviewed, how it ended, what it cost.
CREATE TABLE IF NOT EXISTS cloud_reviews (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id       TEXT NOT NULL,
  owner         TEXT NOT NULL,
  name          TEXT NOT NULL,
  number        INTEGER NOT NULL,
  head_sha      TEXT NOT NULL,
  status        TEXT NOT NULL,          -- running | done | failed | no_credit
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  findings      INTEGER NOT NULL DEFAULT 0,
  blockers      INTEGER NOT NULL DEFAULT 0,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micros   INTEGER NOT NULL DEFAULT 0,
  error         TEXT
);
CREATE INDEX IF NOT EXISTS cloud_reviews_team ON cloud_reviews (team_id, started_at);
`;

const int = (v, d, lo, hi) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : d;
};
const monthStart = (t) => {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
};
const nextMonth = (t) => {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
};
const dollars = (micros) => `$${(micros / MICROS).toFixed(2)}`;
const day = (t) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function cloudConfig(env = process.env) {
  const key = String(env.GRAPIM_REVIEW_ANTHROPIC_KEY ?? env.ANTHROPIC_API_KEY ?? '').trim();
  const model = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,99}$/.test(String(env.GRAPIM_REVIEW_MODEL ?? '')) ? env.GRAPIM_REVIEW_MODEL : DEFAULT_MODEL;
  const credit = { ...DEFAULT_CREDIT };
  try {
    for (const [plan, v] of Object.entries(JSON.parse(env.GRAPIM_REVIEW_MONTHLY_CREDIT || '{}') ?? {})) {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0 && n <= 1e6) credit[plan] = n;
    }
  } catch {}
  let price = PRICES[model] ?? PRICES[DEFAULT_MODEL];
  try {
    const p = env.GRAPIM_REVIEW_PRICE ? JSON.parse(env.GRAPIM_REVIEW_PRICE) : null;
    if (p && Number(p.input) >= 0 && Number(p.output) >= 0) price = { input: +p.input, output: +p.output };
  } catch {}
  const cfg = {
    model,
    modelName: MODEL_NAMES[model] ?? model,
    baseUrl: String(env.ANTHROPIC_BASE_URL ?? '').trim() || null,
    credit: Object.freeze(credit),
    price: Object.freeze(price),
    jobMs: int(env.GRAPIM_REVIEW_JOB_MS, JOB_MS, 60_000, 3_600_000),
    concurrency: int(env.GRAPIM_REVIEW_CONCURRENCY, 2, 1, 8),
    configured: !!key,
  };
  Object.defineProperty(cfg, 'key', { value: key || null, enumerable: false });
  return Object.freeze(cfg);
}

export const costMicros = (price, input, output) => Math.round(input * price.input + output * price.output);

// Runs git without a shell. The token reaches git only as an http header
// through GIT_CONFIG_* in its env: never in argv, a URL or a file.
function runGit(args, { cwd, token = null, signal, timeoutMs = 10 * 60 * 1000 }) {
  return new Promise((resolve, reject) => {
    const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? os.tmpdir(), GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SystemRoot: process.env.SystemRoot ?? '' };
    if (token) {
      env.GIT_CONFIG_COUNT = '1';
      env.GIT_CONFIG_KEY_0 = 'http.extraHeader';
      env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
    }
    const child = spawn('git', ['-c', 'core.quotePath=false', ...args], { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      if (out.length < 1e6) out += d;
    });
    child.stderr.on('data', (d) => {
      if (err.length < 4000) err += d;
    });
    const kill = () => child.kill('SIGKILL');
    const t = setTimeout(kill, timeoutMs);
    signal?.addEventListener('abort', kill, { once: true });
    child.on('error', (e) => {
      clearTimeout(t);
      reject(new Error(`git ${args[0]}: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(t);
      signal?.removeEventListener('abort', kill);
      resolve({ code, out, err: err.trim().split('\n')[0] ?? '' });
    });
  });
}

// The review engine in a child process: one JSON job in, one JSON line out.
function runWorker(job, { key, baseUrl, signal, timeoutMs, log }) {
  return new Promise((resolve, reject) => {
    const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? os.tmpdir(), SystemRoot: process.env.SystemRoot ?? '', ANTHROPIC_API_KEY: key };
    if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;
    const child = spawn(process.execPath, [WORKER], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let lines = 0;
    child.stdout.on('data', (d) => {
      if (out.length < 32e6) out += d;
    });
    child.stderr.on('data', (d) => {
      // Engine progress: counts and sizes only, never code or the key.
      for (const l of String(d).split('\n')) if (l.trim() && lines++ < 40) log(`cloud review: ${l.trim().slice(0, 200)}`);
    });
    const kill = () => child.kill('SIGKILL');
    const t = setTimeout(kill, timeoutMs);
    signal?.addEventListener('abort', kill, { once: true });
    child.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
    child.on('close', (code, sig) => {
      clearTimeout(t);
      signal?.removeEventListener('abort', kill);
      const last = out.trim().split('\n').pop();
      try {
        resolve(JSON.parse(last));
      } catch {
        resolve({ ok: false, error: sig ? 'The review ran out of time.' : `The review stopped (exit ${code}).` });
      }
    });
    child.stdin.end(JSON.stringify(job));
  });
}

export function createCloudReview(hub, { auth, installs, apiBase, fetch, slug, env = process.env, gitUrl = null, signal: stopSignal } = {}) {
  const { db, now, log, teams } = hub;
  db.exec(CLOUD_SCHEMA);
  const cfg = cloudConfig(env);
  const remote = gitUrl ?? ((owner, name) => `${apiBase === 'https://api.github.com' ? 'https://github.com' : apiBase.replace(/\/api\/v3$/, '')}/${owner}/${name}.git`);

  const enabled = (teamId) => !!db.prepare('SELECT enabled FROM cloud_review_settings WHERE team_id = ?').get(teamId)?.enabled;
  const setEnabled = (teamId, on, userId) =>
    db
      .prepare('INSERT INTO cloud_review_settings (team_id, enabled, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(team_id) DO UPDATE SET enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = excluded.updated_at')
      .run(teamId, on ? 1 : 0, userId, now());

  function budgetOf(team) {
    return Math.round((cfg.credit[team?.plan] ?? cfg.credit.free ?? DEFAULT_CREDIT.free) * MICROS);
  }
  function month(teamId) {
    const from = monthStart(now());
    const r = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(cost_micros), 0) AS spent FROM cloud_reviews WHERE team_id = ? AND started_at >= ? AND status != 'no_credit'").get(teamId, from);
    return { reviews: r.n, spent: r.spent };
  }
  function usage(team) {
    const m = month(team.id);
    return { reviews: m.reviews, spent: m.spent / MICROS, budget: budgetOf(team) / MICROS, resets_at: nextMonth(now()), model: cfg.model };
  }

  async function check(client, repo, id, body) {
    try {
      const r = id ? await client.request('PATCH', `/repos/${repo}/check-runs/${id}`, body) : await client.request('POST', `/repos/${repo}/check-runs`, body);
      return r.ok ? r.json?.id ?? id : id;
    } catch {
      return id;
    }
  }

  async function ours(client, url, test) {
    for (let page = 1; page <= 10; page++) {
      const r = await client.request('GET', `${url}?per_page=100&page=${page}`);
      if (!r.ok || !Array.isArray(r.json)) return null;
      const hit = r.json.find((c) => typeof c?.body === 'string' && c.user?.type === 'Bot' && (!slug || c.user.login === `${slug}[bot]`) && test(c));
      if (hit) return hit;
      if (r.json.length < 100) return null;
    }
    return null;
  }

  // Inline comments in one review; what GitHub refuses moves to the summary.
  async function post(client, repo, number, head, findings) {
    let inline = findings;
    let moved = [];
    if (!inline.length) return { inline: 0, moved };
    if (await ours(client, `/repos/${repo}/pulls/${number}/reviews`, (r) => r.body.includes(INLINE_MARKER) && r.commit_id === head)) return { inline: 0, moved, existing: true };
    const send = (list) =>
      client.request('POST', `/repos/${repo}/pulls/${number}/reviews`, {
        commit_id: head,
        event: 'COMMENT',
        body: `${INLINE_MARKER}\n**Grapim Review**: ${countText(counts(list))} on ${head.slice(0, 7)}${list.length < findings.length ? `, ${plural(findings.length - list.length, 'more finding')} in the summary comment` : ''}.`,
        comments: list.map((f) => toComment(f, md)),
      });
    let r = await send(inline);
    if (r.status === 422) {
      const files = [];
      for (let page = 1; page <= 30; page++) {
        const f = await client.request('GET', `/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`);
        if (!f.ok || !Array.isArray(f.json)) break;
        files.push(...f.json);
        if (f.json.length < 100) break;
      }
      const lines = diffLines(files);
      const fits = (c) => (lines[c.path] ?? []).some((h) => h.has(c.line) && (c.start_line === undefined || h.has(c.start_line)));
      const keep = inline.filter((f) => fits(toComment(f, md)));
      moved = inline.filter((f) => !keep.includes(f));
      inline = keep;
      r = keep.length ? await send(keep) : null;
      if (r && !r.ok) {
        moved = findings;
        inline = [];
      }
    }
    return { inline: inline.length, moved };
  }

  async function summary(client, repo, number, text) {
    const existing = await ours(client, `/repos/${repo}/issues/${number}/comments`, (c) => c.body.startsWith(CLOUD_MARKER));
    if (existing?.body === text) return;
    if (existing) await client.request('PATCH', `/repos/${repo}/issues/comments/${existing.id}`, { body: text });
    else await client.request('POST', `/repos/${repo}/issues/${number}/comments`, { body: text });
  }

  async function review(job, signal) {
    const team = teams.get(job.teamId);
    if (!team || !enabled(team.id) || !cfg.configured || !auth) return { skipped: 'off' };
    if (!NAME.test(job.owner) || !NAME.test(job.name) || !Number.isSafeInteger(job.number) || !SHA.test(job.headSha)) return { skipped: 'bad_job' };
    const repo = `${job.owner}/${job.name}`;
    const token = await auth.installationToken(job.installationId);
    const client = new GitHubClient({ apiBase, token, fetch, now, signal });
    const started = now();
    const budget = budgetOf(team);
    const m = month(team.id);
    const rowId = db
      .prepare('INSERT INTO cloud_reviews (team_id, owner, name, number, head_sha, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(team.id, job.owner, job.name, job.number, job.headSha, m.spent >= budget ? 'no_credit' : 'running', started).lastInsertRowid;
    const finish = (fields) => {
      const keys = Object.keys(fields);
      db.prepare(`UPDATE cloud_reviews SET ${[...keys.map((k) => `${k} = ?`), 'finished_at = ?'].join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), now(), rowId);
    };

    if (m.spent >= budget) {
      await check(client, repo, null, {
        name: CLOUD_CHECK,
        head_sha: job.headSha,
        status: 'completed',
        conclusion: 'neutral',
        output: { title: 'No review credit left this month', summary: `Your team has used this month's ${dollars(budget)} of cloud review on the ${team.plan} plan. It renews on ${day(nextMonth(started))}. An owner can upgrade the plan in Settings.` },
      });
      finish({});
      return { skipped: 'no_credit' };
    }

    const checkId = await check(client, repo, null, {
      name: CLOUD_CHECK,
      head_sha: job.headSha,
      status: 'in_progress',
      started_at: new Date(started).toISOString(),
      output: { title: `Reviewing with ${cfg.modelName}`, summary: `Grapim is reviewing this pull request in the cloud. A deep review usually takes up to 20 minutes. The findings will appear here and as comments on the pull request.` },
    });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grapim-review-'));
    try {
      const pr = await client.rest('GET', `/repos/${repo}/pulls/${job.number}`);
      if (pr?.state !== 'open') {
        finish({ status: 'failed', error: 'closed' });
        await check(client, repo, checkId, { status: 'completed', conclusion: 'skipped', output: { title: 'Pull request closed', summary: 'Nothing was reviewed.' } });
        return { skipped: 'closed' };
      }
      const baseRef = String(pr.base?.ref ?? '');
      if (!baseRef || baseRef.length > 250 || /\.\.|[\s~^:?*[\\]/.test(baseRef)) throw new Error('The base branch name is not one Grapim can fetch.');

      await runGit(['init', '-q', dir], { signal });
      const fetched = await runGit(['fetch', '--no-tags', '--quiet', remote(job.owner, job.name), `+refs/heads/${baseRef}:refs/remotes/origin/base`, `+refs/pull/${job.number}/head:refs/remotes/origin/pr`], { cwd: dir, token, signal });
      if (fetched.code !== 0) throw new Error(`Fetching the pull request failed (${fetched.err.replace(token, '***').slice(0, 200)}).`);
      // Provenance notes, when the repository has them.
      await runGit(['fetch', '--no-tags', '--quiet', remote(job.owner, job.name), '+refs/notes/grapim:refs/notes/grapim'], { cwd: dir, token, signal });
      const head = (await runGit(['rev-parse', 'refs/remotes/origin/pr'], { cwd: dir, signal })).out.trim();
      const base = (await runGit(['merge-base', 'refs/remotes/origin/base', 'refs/remotes/origin/pr'], { cwd: dir, signal })).out.trim();
      if (!SHA.test(head) || !SHA.test(base)) throw new Error('The pull request has no common history with its base branch.');

      const request = await statedRequest({ pr, repo, request: (method, url) => client.request(method, url), lib: { closingIssues }, log: () => {} });
      const out = await runWorker({ dir, base, head, model: cfg.model, request }, { key: cfg.key, baseUrl: cfg.baseUrl, signal, timeoutMs: cfg.jobMs, log });
      if (!out?.ok) {
        const msg = String(out?.error ?? 'The review failed.').split(cfg.key).join('***');
        finish({ status: 'failed', error: msg.slice(0, 500) });
        await check(client, repo, checkId, { status: 'completed', conclusion: 'neutral', output: { title: out?.config ? 'Grapim Review configuration error' : 'Grapim Review could not finish', summary: md(msg, 1000) } });
        return { failed: msg };
      }
      const result = out.result;
      const st = result.stats ?? {};
      const cost = costMicros(cfg.price, st.inputTokens ?? 0, st.outputTokens ?? 0);
      const findings = (result.findings ?? []).filter((f) => f && typeof f.path === 'string' && Number.isSafeInteger(f.line) && f.line >= 1);
      const n = counts(findings);
      finish({ status: 'done', findings: findings.length, blockers: n.blocker, input_tokens: st.inputTokens ?? 0, output_tokens: st.outputTokens ?? 0, cost_micros: cost });

      const posted = await post(client, repo, job.number, head, findings);
      const text = summaryMarkdown({ summary: result.summary, extra: posted.moved, heading: 'Not on a changed line', md, limit: LIMIT }).replace(MARKER, CLOUD_MARKER);
      await summary(client, repo, job.number, text);
      const failOn = result.failOn === 'never' ? 'never' : 'blocker';
      await check(client, repo, checkId, {
        status: 'completed',
        conclusion: failOn === 'blocker' && n.blocker ? 'failure' : 'success',
        output: { title: `${countText(n)[0].toUpperCase()}${countText(n).slice(1)}`, summary: text.replace(CLOUD_MARKER, '').trim().slice(0, LIMIT) },
      });
      return { done: true, counts: n, cost };
    } catch (err) {
      const msg = String(err?.message ?? err).split(token).join('***');
      finish({ status: 'failed', error: msg.slice(0, 500) });
      await check(client, repo, checkId, { status: 'completed', conclusion: 'neutral', output: { title: 'Grapim Review could not finish', summary: md(msg, 1000) } });
      return { failed: msg };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  }

  const queue = new JobQueue({
    concurrency: cfg.concurrency,
    log,
    run: async (job) => {
      const signal = stopSignal ? AbortSignal.any([stopSignal, AbortSignal.timeout(cfg.jobMs + 60_000)]) : AbortSignal.timeout(cfg.jobMs + 60_000);
      const r = await review(job, signal);
      log(r.done ? `cloud review: ${countText(r.counts)}, ${dollars(r.cost)}` : r.failed ? 'cloud review failed' : `cloud review skipped: ${r.skipped}`);
      return r;
    },
  });

  // From the App's pull_request handler. True when a review was queued.
  function onPullRequest(job) {
    if (!cfg.configured || !auth || !job.teamId || !enabled(job.teamId)) return false;
    return queue.push(`${job.installationId}:${job.repoId}:${job.number}`, job, String(job.installationId));
  }

  // Settings, GitHub (owners): on or off, and this month's use.
  function card(team, csrf) {
    const linked = installs.forTeam(team.id).length > 0;
    const on = enabled(team.id);
    const u = usage(team);
    const allowed = cfg.configured && linked;
    return html`<section class="card" id="cloud-review" aria-labelledby="cloud-review-title">
  <div class="card-head">
    <h2 id="cloud-review-title" class="card-title">Cloud review</h2>
    <form method="post" action="/hub/teams/${team.id}/github/cloud-review" class="inline-form">
      ${csrfField(csrf)}
      <input type="hidden" name="enabled" value="${on ? '0' : '1'}">
      <span class="badge ${on ? 'badge-ok' : ''}">${on ? 'On' : 'Off'}</span>
      <button class="btn btn-sm" type="submit" ${!on && !allowed ? html`disabled aria-disabled="true"` : ''}>${on ? 'Turn off' : 'Turn on'}</button>
    </form>
  </div>
  <p class="card-sub">${!cfg.configured
    ? 'Cloud review is not set up on this hub.'
    : !linked
      ? 'Connect the GitHub App first. Then Grapim can review every pull request without any setup in CI.'
      : html`Grapim reviews every pull request with ${cfg.modelName} on Grapim's model account, with nothing to set up in CI. A review usually takes up to 20 minutes and posts its findings as comments and a <code>${CLOUD_CHECK}</code> check.`}</p>
  ${cfg.configured && linked
    ? html`<p class="fine">This month: ${plural(u.reviews, 'review')}, $${u.spent.toFixed(2)} of $${u.budget.toFixed(2)} credit on the ${team.plan} plan. Renews ${day(u.resets_at)}.</p>
  <p class="fine">The code of each pull request is fetched into a temporary folder on Grapim's server, sent to Anthropic for the review, and deleted when the review ends. To keep code off Grapim's servers, run <a class="link" href="/docs/review">Grapim Review in your own CI</a> instead.</p>`
    : ''}
</section>`;
  }

  return { config: cfg, enabled, setEnabled, usage, card, onPullRequest, review, queue, close: () => queue.close() };
}
