#!/usr/bin/env node
// Builds bench/data/martian.json (the PRs of Martian's offline Code Review
// Bench in this harness's format) from bench/cache/martian/benchmark_data.json.
//
//   node bench/martian-build.mjs [--from coderabbit]
//
// Every PR of the benchmark was opened once per tool in a public fork
// (github.com/code-review-benchmark/<repo>__<tool>__PR<n>__<date>). This reads
// base and head from one tool's fork, at the pull request number the
// benchmark data names (not always #1: some forks carry older pull requests),
// and takes the merge base as the base, as GitHub's own PR diff does (the
// fork's main branch is often a commit or more ahead of where the PR starts).
// A PR is checked against the files that tool's comments are on.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { BENCH_DIR, CACHE_DIR } from './lib/gh.mjs';

const args = process.argv.slice(2);
const from = args.includes('--from') ? args[args.indexOf('--from') + 1] : 'coderabbit';
const bd = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, 'martian', 'benchmark_data.json'), 'utf8'));
const gh = (p, jq) => JSON.parse(execFileSync('gh', ['api', p, ...(jq ? ['--jq', jq] : [])], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }));

const prs = [];
let bad = 0;
for (const [url, p] of Object.entries(bd)) {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  const id = `${p.source_repo.replace(/[^A-Za-z0-9.-]/g, '-')}__${m[3]}`;
  const review = p.reviews.find((r) => r.tool === from);
  const n = Number(review?.pr_url?.match(/\/pull\/(\d+)/)?.[1]);
  if (!review || !n) {
    bad++;
    console.log(`NO FORK   ${id}`);
    continue;
  }
  const repo = `code-review-benchmark/${review.repo_name}`;
  try {
    const j = gh(`repos/${repo}/pulls/${n}`);
    const cmp = gh(`repos/${repo}/compare/${j.base.sha}...${j.head.sha}`, '{mb: .merge_base_commit.sha, behind: .behind_by, files: [.files[].filename]}');
    const commented = [...new Set((review.review_comments ?? []).map((c) => c.path).filter(Boolean))];
    const hit = commented.filter((f) => cmp.files.includes(f)).length;
    const check = !commented.length ? 'no comment paths to check' : hit ? `${hit}/${commented.length} comment paths in the diff` : 'NONE of the comment paths are in the diff';
    if (commented.length && !hit) bad++;
    prs.push({
      id,
      repo,
      number: n,
      url,
      fork_url: j.html_url,
      title: j.title ?? p.pr_title,
      body: j.body ?? '',
      base_sha: cmp.mb,
      pr_base_sha: j.base.sha,
      head_sha: j.head.sha,
      head_ref: j.head.ref,
      commits_ahead: j.commits,
      changed_files: j.changed_files,
      additions: j.additions,
      deletions: j.deletions,
      source_repo: p.source_repo,
      linked_issues: [],
      issues: [],
      golden: p.golden_comments,
    });
    console.log(`${commented.length && !hit ? 'MISMATCH ' : 'ok       '} ${id}  #${n} ${j.head.ref}  ${j.changed_files} files +${j.additions} -${j.deletions}  main ahead by ${cmp.behind}  (${check})`);
  } catch (err) {
    bad++;
    console.log(`FAILED    ${id}  ${repo}#${n}: ${String(err.stderr || err.message).trim().slice(0, 120)}`);
  }
}
const out = path.join(BENCH_DIR, 'data', 'martian.json');
fs.writeFileSync(out, JSON.stringify({ note: `Martian offline Code Review Bench (github.com/withmartian/code-review-benchmark, MIT): ${prs.length} PRs, golden comments as text (no path or line). base (the merge base) and head from the public ${from} forks.`, prs }, null, 1));
console.log(`${prs.length} PRs written to ${out}; ${bad} problems`);
