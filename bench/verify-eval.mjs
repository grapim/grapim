// Does the second look (src/airev/verify.js) drop false findings and keep
// real ones? Runs it on review results whose findings people checked by hand.
//
//   node bench/verify-eval.mjs --data <prs.json> --results <dir with grapim-lean/*.json> --labels <labels.json> [--via-cli]
//
// labels.json: [{ url, path, line, title, label: "real" | "false" | "unsure" }]
// The pull request discussion is read from GitHub (read only) and cut at the
// time the review ran, so a later explanation cannot help. Comments from bots
// are left out.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { anthropicProvider } from '../src/airev/index.js';
import { verifyFindings } from '../src/airev/verify.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const viaCli = argv.includes('--via-cli');
// The git cache of the checkout that ran the reviews (a worktree has none).
const lib = await import(pathToFileURL(opt('bench-lib', path.join(here, 'lib', 'git.mjs'))).href);
const MODEL = process.env.BENCH_MODEL || 'claude-opus-5-5';

const data = JSON.parse(fs.readFileSync(opt('data'), 'utf8'));
const labels = JSON.parse(fs.readFileSync(opt('labels'), 'utf8'));
const dir = path.join(opt('results'), 'grapim-lean');
const out = opt('out', path.join(opt('results'), 'verify-eval.json'));

let provider;
if (viaCli) {
  const { claudeCliProvider } = await import(pathToFileURL(path.join(path.dirname(opt('bench-lib', path.join(here, 'lib', 'git.mjs'))), 'cli-provider.mjs')).href);
  provider = claudeCliProvider({ model: MODEL });
} else provider = anthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY, model: MODEL });

const gh = (p) => {
  try {
    return JSON.parse(execFileSync('gh', ['api', '--paginate', p], { encoding: 'utf8', maxBuffer: 64e6 }));
  } catch {
    return [];
  }
};
// The same rule as cloud review: the author and people with write access.
function discussionBefore(repo, n, at, author) {
  const t = Date.parse(at);
  const trusted = (c) => ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(c.author_association) || c.user?.login === author;
  const keep = (c) => c?.user?.type !== 'Bot' && !/\[bot\]$/.test(c?.user?.login ?? '') && trusted(c) && Date.parse(c.created_at ?? c.submitted_at ?? 0) < t && String(c.body ?? '').trim();
  const lines = [];
  for (const c of gh(`repos/${repo}/issues/${n}/comments`).filter(keep)) lines.push(`${c.user.login}: ${c.body}`);
  for (const c of gh(`repos/${repo}/pulls/${n}/reviews`).filter(keep)) lines.push(`${c.user.login} (review): ${c.body}`);
  for (const c of gh(`repos/${repo}/pulls/${n}/comments`).filter(keep)) lines.push(`${c.user.login} on ${c.path}:${c.line ?? c.original_line}: ${c.body}`);
  return lines.join('\n\n');
}

const label = (url, f) => labels.find((l) => l.url === url && l.path === f.path && l.line === f.line && (!l.title || f.title.startsWith(l.title)))?.label ?? null;
const rows = [];
for (const file of fs.readdirSync(dir).sort()) {
  const r = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  if (!(r.findings ?? []).length) continue;
  const pr = data.prs.find((p) => p.url === r.url);
  if (!pr) continue;
  const gitDir = lib.prRepo(pr);
  // The bench clones are partial: a grep over the whole tree waits on GitHub
  // for every file. Here name lookups search only the files the pull request
  // changed (cloud review fetches the full tree and searches all of it, so
  // this measures the second look with less context than it really has).
  const changed = (lib.git(gitDir, ['diff', '--name-only', pr.base_sha, pr.head_sha], { allowFail: true }) ?? '').split('\n').filter(Boolean);
  const git = (args) => (args[0] === 'grep' ? (changed.length ? lib.git(gitDir, [...args, '--', ...changed], { allowFail: true, noLazy: true }) : null) : lib.git(gitDir, args, { allowFail: true }));
  const discussion = discussionBefore(pr.repo, pr.number, r.at, pr.author);
  const request = { text: `${pr.title}\n\n${pr.body ?? ''}` };
  const v = await verifyFindings({ findings: r.findings, git, base: pr.base_sha, head: pr.head_sha, provider, model: MODEL, request, discussion, log: (l) => console.error(`${pr.repo}#${pr.number}: ${l}`) });
  const dropped = new Map(v.dropped.map((d) => [d.finding, d.reason]));
  for (const f of r.findings) rows.push({ url: r.url, path: f.path, line: f.line, title: f.title, label: label(r.url, f), verdict: dropped.has(f) ? 'drop' : 'keep', reason: dropped.get(f) ?? '' });
  console.error(`${pr.repo}#${pr.number}: ${v.checked} checked, ${v.dropped.length} dropped, ${v.usage.input} in / ${v.usage.output} out tokens`);
}
fs.writeFileSync(out, JSON.stringify(rows, null, 1));

const n = (lab, ver) => rows.filter((x) => x.label === lab && x.verdict === ver).length;
console.log(`false findings dropped: ${n('false', 'drop')} of ${n('false', 'drop') + n('false', 'keep')}`);
console.log(`real findings kept:     ${n('real', 'keep')} of ${n('real', 'keep') + n('real', 'drop')}`);
console.log(`unlabelled: ${rows.filter((x) => !x.label).length}`);
for (const x of rows.filter((x) => (x.label === 'real' && x.verdict === 'drop') || (x.label === 'false' && x.verdict === 'keep'))) console.log(`MISS ${x.label}/${x.verdict} ${x.url} ${x.path}:${x.line} ${x.title}${x.reason ? `\n   reason: ${x.reason}` : ''}`);
provider.close?.();
