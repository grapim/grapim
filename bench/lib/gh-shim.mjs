#!/usr/bin/env node
// A stand-in for the `gh` CLI inside the claude-action adapter. The review
// prompt of claude-code-action calls `gh pr diff`, `gh pr view` and
// `gh pr comment`; on GitHub they would read the pull request as it is today
// (after the fix commits) and post comments. Here they answer from the
// benchmark's snapshot of the PR at the reviewed head and record comments
// locally. Everything else is refused. Env: BENCH_PR_DIR (the snapshot
// folder: pr.json, pr.diff) and BENCH_COMMENTS_FILE.

import fs from 'node:fs';
import path from 'node:path';

const dir = process.env.BENCH_PR_DIR;
const args = process.argv.slice(2);
const out = (s) => process.stdout.write(s.endsWith('\n') ? s : `${s}\n`);
const fail = (s) => {
  process.stderr.write(`${s}\n`);
  process.exit(1);
};

if (!dir) fail('gh (benchmark shim): BENCH_PR_DIR is not set');
const pr = JSON.parse(fs.readFileSync(path.join(dir, 'pr.json'), 'utf8'));
const [group, cmd, ...rest] = args;

if (group !== 'pr') fail(`gh (benchmark shim): only "gh pr diff|view|comment" are available in this review, not "gh ${args.join(' ')}".`);
if (cmd === 'diff') {
  out(fs.readFileSync(path.join(dir, 'pr.diff'), 'utf8'));
} else if (cmd === 'view') {
  const json = rest.includes('--json');
  if (json) {
    out(JSON.stringify({ number: pr.number, title: pr.title, body: pr.body, author: { login: pr.author }, baseRefName: 'base', headRefName: 'head', files: pr.files.map((f) => ({ path: f })), state: 'OPEN', url: pr.url }));
  } else {
    out(`title:\t${pr.title}\nstate:\tOPEN\nauthor:\t${pr.author}\nnumber:\t${pr.number}\nurl:\t${pr.url}\n--\n${pr.body ?? ''}`);
  }
} else if (cmd === 'comment') {
  const i = rest.findIndex((a) => a === '--body' || a === '-b');
  let body = i >= 0 ? rest[i + 1] : '';
  const f = rest.findIndex((a) => a === '--body-file' || a === '-F');
  if (f >= 0) body = rest[f + 1] === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(rest[f + 1], 'utf8');
  if (process.env.BENCH_COMMENTS_FILE) fs.appendFileSync(process.env.BENCH_COMMENTS_FILE, JSON.stringify({ ts: new Date().toISOString(), kind: 'pr_comment', body }) + '\n');
  out(`${pr.url}#issuecomment-bench`);
} else {
  fail(`gh (benchmark shim): "gh pr ${cmd}" is not available in this review.`);
}
