#!/usr/bin/env node
// Builds bench/data/prs.json, the benchmark dataset: real public pull requests
// written by AI coding agents, each with the problems a human reviewer found
// in it (the ground truth) or marked clean.
//
//   node bench/collect.mjs discover [--pages 2]
//       Searches GitHub (read-only, cached in bench/cache/) for agent-written
//       PRs in active repos and writes bench/cache/candidates.json plus a
//       digest of every candidate's human review comments and the commits
//       after them (bench/cache/digest.md), for annotation.
//
//   node bench/collect.mjs build [--offline]
//       Reads the hand-written annotations (bench/data/annotations.json: which
//       PRs, the reviewed head commit, the ground-truth issues and their
//       evidence) and fetches everything else from GitHub (base sha, title,
//       body, linked issues and their bodies) into bench/data/prs.json.
//
// The annotations are the part a person wrote by reading the human comments
// and the fix commits; `build` makes the rest reproducible.

import fs from 'node:fs';
import path from 'node:path';
import { api, BENCH_DIR, CACHE_DIR } from './lib/gh.mjs';
import { linkedIssues } from './lib/linked.mjs';
import { searchCandidates, timeline, repoInfo, repoQueries, MIN_STARS } from './lib/discover.mjs';

const DATA = path.join(BENCH_DIR, 'data');
const log = (s) => process.stderr.write(`${s}\n`);

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      const k = i++;
      try {
        out[k] = await fn(items[k], k);
      } catch (err) {
        log(`  ${items[k].repo ?? ''}#${items[k].number ?? ''}: ${err.message}`);
        out[k] = null;
      }
    }
  }));
  return out;
}

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\r\n/g, '\n').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

async function discover(args) {
  const pages = Number(args[args.indexOf('--pages') + 1]) || 2;
  const ri = args.indexOf('--repos');
  const repoList = ri >= 0 ? fs.readFileSync(args[ri + 1], 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')) : null;
  const found = [
    ...(await searchCandidates({ pages, log })),
    ...(repoList ? await searchCandidates({ pages: 1, perPage: 30, log, queries: repoQueries(repoList) }) : []),
  ].filter((c, i, a) => a.findIndex((x) => x.repo === c.repo && x.number === c.number) === i);
  log(`${found.length} candidate PRs from search`);
  const repos = [...new Set(found.map((c) => c.repo))];
  const info = new Map();
  await pool(repos, 12, async (r) => info.set(r, await repoInfo(r)));
  const active = found.filter((c) => {
    const r = info.get(c.repo);
    return r && !r.fork && !r.archived && r.stars >= MIN_STARS;
  });
  log(`${active.length} in repos with >= ${MIN_STARS} stars`);
  // At most --per-repo PRs per repository and agent, the most discussed first
  // (the core API allows 5000 requests an hour; a timeline costs 5).
  const perRepo = Number(args[args.indexOf('--per-repo') + 1]) || 4;
  const groups = new Map();
  for (const c of active) groups.set(`${c.repo} ${c.agent}`, [...(groups.get(`${c.repo} ${c.agent}`) ?? []), c]);
  const picked = [...groups.values()].flatMap((g) => g.sort((a, b) => (b.comments ?? 0) - (a.comments ?? 0)).slice(0, perRepo));
  log(`${picked.length} after keeping ${perRepo} per repository and agent`);
  const tl = (await pool(picked, 10, timeline)).filter(Boolean);
  for (const t of tl) t.stars = info.get(t.repo)?.stars ?? 0;
  fs.writeFileSync(path.join(CACHE_DIR, 'candidates.json'), JSON.stringify(tl, null, 1));

  // The digest: PRs with human inline comments followed by commits first.
  tl.sort((a, b) => b.fixedAfter - a.fixedAfter || b.feedbackThenCommit - a.feedbackThenCommit || b.stars - a.stars);
  const md = [];
  for (const t of tl) {
    md.push(`\n## ${t.repo}#${t.number} [${t.agent}] ${t.state} ★${t.stars} +${t.additions}/-${t.deletions} files ${t.changedFiles} commits ${t.commits.length} fixedAfter ${t.fixedAfter} feedback ${t.feedbackThenCommit} approved ${t.approved}`);
    md.push(`${t.title}  ${t.url}`);
    const events = [
      ...t.commits.map((k) => ({ d: k.date, s: `  C ${k.sha.slice(0, 9)} ${clip(k.msg, 100)}` })),
      ...t.human.filter((h) => !h.reply).map((h) => ({ d: h.date, s: `  R ${h.user} ${h.path}:${h.line} @${String(h.commit).slice(0, 9)} :: ${clip(h.body, 400).replace(/\n+/g, ' / ')}` })),
      ...t.humanReviews.map((r) => ({ d: r.date, s: `  V ${r.user} ${r.state} @${String(r.commit).slice(0, 9)} :: ${clip(r.body, 300).replace(/\n+/g, ' / ')}` })),
      ...t.humanIssue.map((r) => ({ d: r.date, s: `  I ${r.user} :: ${clip(r.body, 300).replace(/\n+/g, ' / ')}` })),
    ].sort((a, b) => Date.parse(a.d) - Date.parse(b.d));
    md.push(...events.map((e) => e.s));
  }
  fs.writeFileSync(path.join(CACHE_DIR, 'digest.md'), md.join('\n'));
  log(`wrote ${path.join(CACHE_DIR, 'candidates.json')} and digest.md (${tl.length} PRs, ${tl.filter((t) => t.fixedAfter).length} with comments followed by commits)`);
}

async function build(args) {
  const offline = args.includes('--offline');
  const ann = JSON.parse(fs.readFileSync(path.join(DATA, 'annotations.json'), 'utf8'));
  const prs = [];
  for (const a of ann.prs) {
    const pr = await api(`repos/${a.repo}/pulls/${a.number}`, { offline });
    if (!pr) {
      log(`skip ${a.repo}#${a.number}: not found`);
      continue;
    }
    const issueNums = a.linked_issues ?? linkedIssues(`${pr.body ?? ''}`, a.repo);
    const issues = [];
    for (const n of issueNums) {
      const is = await api(`repos/${a.repo}/issues/${n}`, { offline });
      if (is && !is.pull_request) issues.push({ number: n, title: is.title, body: clip(is.body, 20_000) });
    }
    // The reviewed head: a (possibly short) sha among the PR's commits.
    const commits = (await api(`repos/${a.repo}/pulls/${a.number}/commits?per_page=100`, { paginate: true, offline })) ?? [];
    const want = String(a.head_sha ?? pr.head.sha).toLowerCase();
    const head = commits.find((k) => k.sha.startsWith(want))?.sha ?? (want.length === 40 ? want : null);
    if (!head) {
      log(`skip ${a.repo}#${a.number}: head ${want} is not a commit of the PR`);
      continue;
    }
    // The diff a reviewer saw: from the merge base with the target branch.
    const cmp = await api(`repos/${a.repo}/compare/${a.base_sha ?? pr.base.sha}...${head}`, { offline });
    const base = cmp?.merge_base_commit?.sha ?? a.base_sha ?? pr.base.sha;
    prs.push({
      id: `${a.repo.replace('/', '__')}__${a.number}`,
      repo: a.repo,
      number: a.number,
      url: pr.html_url,
      agent: a.agent,
      author: pr.user?.login ?? null,
      kind: a.issues?.length ? 'problem' : 'clean',
      base_sha: base,
      head_sha: head,
      commits_ahead: cmp?.ahead_by ?? null,
      final_head_sha: pr.head.sha,
      merged: !!pr.merged_at,
      title: pr.title,
      body: clip(pr.body, 20_000),
      linked_issues: issues,
      issues: (a.issues ?? []).map((i) => ({ confidence: 'high', ...i })),
      notes: a.notes ?? '',
    });
  }
  const out = { version: 1, generated_by: 'bench/collect.mjs build', count: prs.length, prs };
  fs.writeFileSync(path.join(DATA, 'prs.json'), JSON.stringify(out, null, 2) + '\n');
  const by = {};
  for (const p of prs) {
    by[p.agent] ??= { problem: 0, clean: 0, issues: 0 };
    by[p.agent][p.kind]++;
    by[p.agent].issues += p.issues.length;
  }
  log(`wrote bench/data/prs.json: ${prs.length} PRs`);
  for (const [k, v] of Object.entries(by)) log(`  ${k}: ${v.problem} with problems (${v.issues} issues), ${v.clean} clean`);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'discover') await discover(rest);
else if (cmd === 'build') await build(rest);
else {
  log('Usage: node bench/collect.mjs discover [--pages N] | build [--offline]');
  process.exitCode = 1;
}
