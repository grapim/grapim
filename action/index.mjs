// The Grapim provenance GitHub Action (docs/provenance.md section 5). No
// dependencies: the provenance modules are copied into ./dist by bundle.mjs.
//
// On a pull request it fetches refs/notes/grapim and the history it needs,
// blames the added lines at the PR head, renders the summary and creates or
// updates one comment (found by its marker) with the REST API. A forked PR
// gets a read-only token: the summary goes to the job log and the job summary
// instead, and the job still passes.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectFromGit, git, NOTES_REF, resolveCommit } from './dist/pr.js';
import { MARKER, renderEmpty, renderSummary } from './dist/render.js';

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const BOT = 'github-actions[bot]';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client({ api, token, fetch, wait = sleep }) {
  return async function request(method, url, body) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url.startsWith('http') ? url : `${api}${url}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'grapim-provenance-action',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      // Rate limited: wait once for a short reset, else give up.
      if ((res.status === 403 || res.status === 429) && attempt === 0) {
        const after = Number(res.headers.get('retry-after'));
        const reset = Number(res.headers.get('x-ratelimit-reset'));
        const ms = after > 0 ? after * 1000 : res.headers.get('x-ratelimit-remaining') === '0' && reset ? reset * 1000 - Date.now() + 1000 : -1;
        if (ms >= 0 && ms <= 60_000) {
          await wait(ms);
          continue;
        }
      }
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {}
      return { status: res.status, ok: res.ok, json, headers: res.headers };
    }
  };
}

// Our earlier comment: it carries the marker and was written by a bot (people
// cannot post as one), preferably the Actions bot this token belongs to.
async function findComment(request, repo, number) {
  const ours = [];
  for (let page = 1; page <= 20; page++) {
    const r = await request('GET', `/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`);
    if (!r.ok || !Array.isArray(r.json)) break;
    for (const c of r.json) if (typeof c?.body === 'string' && c.body.startsWith(MARKER) && c.user?.type === 'Bot') ours.push(c);
    if (r.json.length < 100) break;
  }
  return ours.find((c) => c.user.login === BOT) ?? ours[0] ?? null;
}

// Untrusted text is escaped by the renderer, but the runner also reads
// "::command::" lines from the log: printing between stop-commands markers
// makes sure nothing in a summary is ever taken as one.
function printSafely(log, title, text) {
  const token = crypto.randomBytes(16).toString('hex');
  log(`::stop-commands::${token}`);
  log(`${title}\n\n${text}`);
  log(`::${token}::`);
}

function prepareHistory(cwd, { base, head, number }, log) {
  if (git(cwd, ['fetch', '--no-tags', '--quiet', 'origin', `+${NOTES_REF}:${NOTES_REF}`], { allowFail: true }) === null) log(`No ${NOTES_REF} on the remote yet.`);
  if ((git(cwd, ['rev-parse', '--is-shallow-repository'], { allowFail: true }) ?? '').trim() === 'true') {
    log('The checkout is shallow: fetching the full history (set fetch-depth: 0 on actions/checkout to skip this).');
    git(cwd, ['fetch', '--no-tags', '--quiet', '--unshallow', 'origin'], { allowFail: true });
  }
  for (const [sha, extra] of [
    [base, null],
    [head, Number.isSafeInteger(number) ? `+refs/pull/${number}/head` : null],
  ]) {
    if (resolveCommit(cwd, sha)) continue;
    git(cwd, ['fetch', '--no-tags', '--quiet', 'origin', sha], { allowFail: true });
    if (!resolveCommit(cwd, sha) && extra) git(cwd, ['fetch', '--no-tags', '--quiet', 'origin', extra], { allowFail: true });
  }
}

function setOutputs(env, stats) {
  if (!env.GITHUB_OUTPUT) return;
  const lines = [`added-lines=${stats.added}`, `ai-lines=${stats.ai}`, `ai-share=${stats.share.toFixed(4)}`, `unreviewed-runs=${stats.unapproved.length}`];
  fs.appendFileSync(env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
}

// -> { status: 'posted' | 'updated' | 'unchanged' | 'log' | 'skipped', stats?, markdown? }
export async function runAction({ env = process.env, cwd, fetch = globalThis.fetch, log = (s) => console.log(s), wait } = {}) {
  const eventPath = env.GITHUB_EVENT_PATH;
  const event = eventPath && fs.existsSync(eventPath) ? JSON.parse(fs.readFileSync(eventPath, 'utf8')) : null;
  const pr = event?.pull_request;
  if (!pr) {
    log('Grapim provenance runs on pull_request events; nothing to do here.');
    return { status: 'skipped' };
  }
  const repo = env.GITHUB_REPOSITORY || event.repository?.full_name;
  const base = pr.base?.sha;
  const head = pr.head?.sha;
  const number = pr.number;
  if (!REPO.test(String(repo)) || !SHA.test(String(base)) || !SHA.test(String(head)) || !Number.isSafeInteger(number)) throw new Error('The pull_request event is missing the repository, base or head.');
  const dir = cwd ?? env.GITHUB_WORKSPACE ?? process.cwd();
  const maxFiles = Math.max(1, Math.min(3000, Number(env['INPUT_MAX-FILES']) || 300));

  prepareHistory(dir, { base, head, number }, log);
  const input = collectFromGit({ cwd: dir, base, head, maxFiles });
  const empty = !input.hasNotes;
  const { markdown, stats } = empty ? { markdown: renderEmpty({ via: 'action' }), stats: renderSummary({}).stats } : renderSummary(input);
  setOutputs(env, stats);
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, markdown.split('\n').filter((l) => !l.startsWith('<!-- grapim')).join('\n'));
  log(empty ? 'No provenance notes in this repo yet.' : `Attributed ${stats.ai} of ${stats.added} added lines to ${stats.runs.length} agent run(s).`);

  const token = env['INPUT_GITHUB-TOKEN'] || env.GITHUB_TOKEN;
  // pull_request from a fork: GitHub gives a read-only token (and no secrets).
  const fork = (pr.head?.repo?.full_name ?? null) !== (pr.base?.repo?.full_name ?? repo);
  if (!token || (fork && env.GITHUB_EVENT_NAME !== 'pull_request_target')) {
    printSafely(log, `Grapim provenance (${!token ? 'no token' : 'pull request from a fork: the token is read-only'}, so it is printed here instead of commented):`, markdown);
    return { status: 'log', stats, markdown };
  }

  const request = client({ api: (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, ''), token, fetch, wait });
  const existing = await findComment(request, repo, number);
  // The "how to enable" note is posted at most once.
  if (empty && existing) return { status: 'unchanged', stats, markdown };
  if (existing && existing.body === markdown) return { status: 'unchanged', stats, markdown };
  const r = existing
    ? await request('PATCH', `/repos/${repo}/issues/comments/${existing.id}`, { body: markdown })
    : await request('POST', `/repos/${repo}/issues/${number}/comments`, { body: markdown });
  if (r.status === 403 || r.status === 404) {
    printSafely(log, 'Grapim provenance (the token cannot comment here: it needs pull-requests: write):', markdown);
    return { status: 'log', stats, markdown };
  }
  if (!r.ok) throw new Error(`GitHub answered ${r.status} when saving the comment.`);
  log(`${existing ? 'Updated' : 'Posted'} the provenance comment${empty ? ' (how to enable provenance)' : ''}.`);
  return { status: existing ? 'updated' : 'posted', stats, markdown, commentId: r.json?.id ?? existing?.id };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runAction().catch((err) => {
    console.log(`::error::Grapim provenance: ${String(err?.message ?? err).replace(/[\r\n]+/g, ' ')}`);
    process.exitCode = 1;
  });
}
