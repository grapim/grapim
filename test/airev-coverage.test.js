// Grapim Review, what a first-time repository gets: with no notes every changed
// line is reviewed (at effort medium, never low), each finding carries a
// confidence and the cut is made in code, a request that holds only part of
// the pull request sees the whole list of changed files, and a file the diff
// already holds is not sent twice. A temp git repo and a fake fetch: no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reviewChanges, DEFAULT_CONFIG, FINDINGS_SCHEMA, SYSTEM_PROMPT, anthropicProvider, validateConfig } from '../src/airev/index.js';
import { collectChanges, planReview } from '../src/airev/diff.js';
import { buildRequest, buildUserContent, CONFIDENCES } from '../src/airev/prompt.js';
import { validateFindings, splitByConfidence, rankFindings, mergePasses } from '../src/airev/findings.js';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (dir, file, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
};

// No refs/notes/grapim. One commit edits one line of a 60-line file, rewrites
// a two-line file, adds a file and deletes a test file.
function plainRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grapim-airev-plain-'));
  git(dir, 'init', '-q', '-b', 'main');
  const big = `${Array.from({ length: 60 }, (_, i) => `export const v${i} = ${i};`).join('\n')}\n`;
  write(dir, 'src/big.js', big);
  write(dir, 'src/small.js', 'export const a = 1;\nexport const b = 2;\n');
  write(dir, 'test/old.test.js', 'test("x", () => {});\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  const base = git(dir, 'rev-parse', 'HEAD');
  write(dir, 'src/big.js', big.replace('export const v30 = 30;', 'export const v30 = 31;'));
  write(dir, 'src/small.js', 'export const a = 10;\nexport const b = 20;\n');
  write(dir, 'src/new.js', 'export const fresh = true;\n');
  fs.rmSync(path.join(dir, 'test/old.test.js'));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'change');
  return { dir, base, head: git(dir, 'rev-parse', 'HEAD') };
}

let shared = null;
const repo = () => (shared ??= plainRepo());
const reader = (dir, head) => (p) => {
  try {
    return git(dir, 'cat-file', 'blob', `${head}:${p}`) + '\n';
  } catch {
    return null;
  }
};

const finding = (p, line, extra = {}) => ({ path: p, line, end_line: line, severity: 'warning', confidence: 'high', category: 'correctness', title: `Problem at ${p}:${line}`, body: 'Explain and fix.', ...extra });

function fakeFetch(respond) {
  const calls = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    return new Response(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: JSON.stringify({ findings: respond(body) }) }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 20 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  fn.calls = calls;
  return fn;
}

test('no notes: the default reviews every changed line, at effort medium', () => {
  const { dir, base, head } = repo();
  const changes = collectChanges({ cwd: dir, base, head, config: DEFAULT_CONFIG });
  assert.equal(changes.hasNotes, false);
  const plan = planReview(changes, DEFAULT_CONFIG, { fileText: reader(dir, head) });
  assert.equal(plan.stats.noNotes, true);
  assert.deepEqual(plan.batches.flatMap((b) => b.units.map((u) => u.path)).sort(), ['src/big.js', 'src/new.js', 'src/small.js']);
  assert.ok(!plan.skipped.some((s) => /human-written/.test(s.reason)), 'nothing is skipped as human-written');
  assert.deepEqual(plan.batches.map((b) => b.effort), ['low'], 'depth low still orders the batches');
  const { body } = buildRequest(plan.batches[0], { model: 'claude-opus-5-5' });
  assert.equal(body.output_config.effort, 'medium', 'never API effort low: the model would skip thinking');
  const text = body.messages[0].content.map((b) => b.text).join('\n');
  assert.match(text, /@@ hunk 1, new lines \d+-\d+, no agent run recorded\n/);
  assert.ok(!text.includes('depth low') && !text.includes('written by human'));

  // "ai-only" is an explicit choice and stays: nothing to review without notes.
  assert.equal(planReview(changes, { ...DEFAULT_CONFIG, review: 'ai-only' }).batches.length, 0);
});

test('file context: sent for a partial change, not for a new or mostly rewritten file', () => {
  const { dir, base, head } = repo();
  const changes = collectChanges({ cwd: dir, base, head, config: DEFAULT_CONFIG });
  const units = Object.fromEntries(planReview(changes, DEFAULT_CONFIG, { fileText: reader(dir, head) }).batches.flatMap((b) => b.units.map((u) => [u.path, u])));
  assert.equal(typeof units['src/big.js'].fileText, 'string');
  assert.equal(units['src/new.js'].fileText, null, 'a new file is already whole in the diff');
  assert.equal(units['src/small.js'].fileText, null, 'so is a file the change mostly rewrites');
  const lean = planReview(changes, DEFAULT_CONFIG, { fileText: reader(dir, head), limits: { fileContextChars: 0 } });
  assert.ok(lean.batches.every((b) => b.units.every((u) => u.fileText === null)));

  // contextLines widens the hunks.
  const wide = collectChanges({ cwd: dir, base, head, config: DEFAULT_CONFIG, limits: { contextLines: 10 } });
  const lines = (c) => c.files.find((f) => f.path === 'src/big.js').hunks[0].lines.length;
  assert.equal(lines(changes), 8);
  assert.equal(lines(wide), 22);
});

test('CHANGES block: a request that holds part of the pull request sees all of it', () => {
  const { dir, base, head } = repo();
  const changes = collectChanges({ cwd: dir, base, head, config: DEFAULT_CONFIG });
  const plan = planReview(changes, DEFAULT_CONFIG, { fileText: reader(dir, head) });
  const overview = changes.files.map((f) => ({ path: f.path, status: f.status, added: f.hunks.reduce((n, h) => n + h.added.length, 0), removed: f.hunks.reduce((n, h) => n + h.lines.filter((l) => l.type === '-').length, 0) }));
  const { content, nonce } = buildUserContent(plan.batches[0], { overview });
  const block = content.map((b) => b.text).find((t) => t.startsWith('<<<GRAPIM-UNTRUSTED kind=CHANGES'));
  assert.ok(block, 'the deleted test file is not in the batch, so the block is there');
  assert.ok(block.endsWith(`<<<END GRAPIM-UNTRUSTED id=${nonce}>>>`));
  assert.match(block, /\n\* M src\/big\.js {2}\+1 -1\n/);
  assert.match(block, /\n\* A src\/new\.js {2}\+1\n/);
  assert.match(block, /\n {2}D test\/old\.test\.js {2}-1\n/);
  assert.match(SYSTEM_PROMPT, /A CHANGES block, when present, lists every file the pull request touches/);

  // Every changed file in the batch: no block, the message is as before.
  const inBatch = overview.filter((o) => o.status !== 'deleted');
  assert.ok(!buildUserContent(plan.batches[0], { overview: inBatch }).content.some((b) => b.text.includes('kind=CHANGES')));
  assert.ok(!buildUserContent(plan.batches[0]).content.some((b) => b.text.includes('kind=CHANGES')));
});

test('confidence: asked for, kept, and the cut is made in code', async () => {
  assert.deepEqual(CONFIDENCES, ['high', 'medium', 'low']);
  const item = FINDINGS_SCHEMA.properties.findings.items;
  assert.ok(item.required.includes('confidence'));
  assert.deepEqual(item.properties.confidence.enum, ['high', 'medium', 'low']);
  assert.match(SYSTEM_PROMPT, /Rate each finding's confidence honestly instead of leaving it out/);
  assert.ok(!/only real defects you are confident about|good and common answer|Fewer, certain findings/.test(SYSTEM_PROMPT), 'no wording that makes the model swallow a defect');

  const allowed = new Map([['a.js', [{ added: new Set([1, 2, 3]) }]]]);
  const noConfidence = finding('a.js', 3);
  delete noConfidence.confidence;
  const v = validateFindings({ findings: [finding('a.js', 1, { confidence: 'low' }), finding('a.js', 2, { confidence: 'medium' }), noConfidence, finding('a.js', 1, { confidence: 'certain', title: 'odd' })] }, allowed);
  assert.deepEqual(v.findings.map((f) => f.confidence), ['low', 'medium', 'high', 'high'], 'a missing or unknown confidence counts as sure');
  const { sure, held } = splitByConfidence(v.findings);
  assert.deepEqual([sure.length, held.length], [3, 1]);
  assert.deepEqual(rankFindings([finding('a.js', 1, { confidence: 'medium' }), finding('a.js', 2, { confidence: 'high' })]).map((f) => f.line), [2, 1], 'the surer of two equally severe findings first');

  const { dir, base, head } = repo();
  const f = fakeFetch(() => [finding('src/big.js', 31, { severity: 'blocker', confidence: 'low', title: 'Maybe off by one' }), finding('src/small.js', 1, { confidence: 'medium' }), finding('src/new.js', 1)]);
  const res = await reviewChanges({ cwd: dir, base, head, config: DEFAULT_CONFIG, provider: anthropicProvider({ apiKey: 'sk-test', model: 'claude-opus-5-5' }), fetchImpl: f, request: { title: 'Bump the values' } });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].output_config.effort, 'medium');
  assert.ok(f.calls[0].messages[0].content.some((b) => b.text.includes('kind=CHANGES')), 'reviewChanges passes the overview');
  assert.deepEqual(res.findings.map((x) => [x.path, x.confidence]), [['src/new.js', 'high'], ['src/small.js', 'medium']], 'low-confidence findings are not posted');
  assert.deepEqual(res.held.map((x) => [x.path, x.line]), [['src/big.js', 31]]);
  assert.equal(res.stats.heldFindings, 1);
  assert.equal(res.stats.noNotes, true);
  assert.match(res.summary, /\*\*Worth a look\*\* \(1 point the review could not confirm from the code it saw, not posted inline\)\n- <code>src&#47;big&#46;js<\/code> line 31: Maybe off by one/);
  assert.match(res.summary, /no agent notes in this repository, so every changed line was a candidate/);
  assert.match(res.summary, /\*\*Tests deleted:\*\*/);
});

test('passes: the same request sent twice, findings merged by place, the prompt cached for the second', async () => {
  assert.equal(DEFAULT_CONFIG.passes, 1);
  assert.equal(validateConfig({ passes: 2 }).passes, 2);
  assert.throws(() => validateConfig({ passes: 4 }), /"passes" must be a whole number from 1 to 3/);

  // Same pass: two findings close together are two problems. Another pass
  // within three lines: the same problem again, the surer wording kept.
  const a = { ...finding('a.js', 10, { title: 'A' }), pass: 0 };
  const b = { ...finding('a.js', 11, { title: 'B' }), pass: 0 };
  const c = { ...finding('a.js', 13, { title: 'C', confidence: 'medium' }), pass: 1 };
  const d = { ...finding('a.js', 30, { title: 'D' }), pass: 1 };
  const e = { ...finding('b.js', 10, { title: 'E' }), pass: 1 };
  assert.deepEqual(mergePasses([c, d, e, a, b]).map((f) => [f.title, f.raised]), [['A', 2], ['B', 1], ['D', 1], ['E', 1]]);
  const single = mergePasses([a, b]);
  assert.deepEqual(single.map((f) => f.title), ['A', 'B']);
  assert.ok(single.every((f) => !('raised' in f) && !('pass' in f)), 'one pass: the findings come back as they were');

  const { dir, base, head } = repo();
  let call = 0;
  const f = fakeFetch(() => (call++ === 0
    ? [finding('src/big.js', 31, { confidence: 'low', title: 'First wording' }), finding('src/new.js', 1, { title: 'Only the first pass' })]
    : [finding('src/big.js', 31, { severity: 'blocker', confidence: 'medium', title: 'Second wording' }), finding('src/small.js', 2, { title: 'Only the second pass' })]));
  const provider = anthropicProvider({ apiKey: 'sk-test', model: 'claude-opus-5-5' });
  const res = await reviewChanges({ cwd: dir, base, head, config: { ...DEFAULT_CONFIG, passes: 2 }, provider, fetchImpl: f });
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[0], f.calls[1], 'the second pass is the same request, so it reads the cache');
  assert.deepEqual(f.calls[0].messages[0].content.at(-1).cache_control, { type: 'ephemeral' });
  assert.deepEqual(res.findings.map((x) => [x.path, x.line, x.title, x.raised]), [
    ['src/big.js', 31, 'Second wording', 2],
    ['src/new.js', 1, 'Only the first pass', 1],
    ['src/small.js', 2, 'Only the second pass', 1],
  ], 'low in one pass and medium in the other: posted once, with the surer wording');
  assert.deepEqual(res.held, []);
  assert.equal(res.stats.requests, 2);
  assert.equal(res.stats.reviewedHunks, 3, 'hunks are counted once, not once per pass');
  assert.match(res.summary, /2 requests \(2 passes over each change\)/);

  // One pass, the default: no cache marker on the message, nothing about passes.
  const g = fakeFetch(() => [finding('src/new.js', 1)]);
  const one = await reviewChanges({ cwd: dir, base, head, config: DEFAULT_CONFIG, provider, fetchImpl: g });
  assert.equal(g.calls.length, 1);
  assert.ok(!g.calls[0].messages[0].content.some((blk) => blk.cache_control));
  assert.ok(!('raised' in one.findings[0]));
  assert.ok(!/passes over each change/.test(one.summary));
});

test('summary: says where the code went, for a review in CI and for one on Grapim\'s server', async () => {
  const { dir, base, head } = repo();
  const provider = anthropicProvider({ apiKey: 'sk-test', model: 'claude-opus-5-5' });
  const inCi = await reviewChanges({ cwd: dir, base, head, config: DEFAULT_CONFIG, provider, fetchImpl: fakeFetch(() => []) });
  assert.match(inCi.summary, /1 request, 100 input and 20 output tokens\./, 'a space after the comma');
  assert.ok(inCi.summary.endsWith('Your code was sent only to the Anthropic API. Grapim received nothing.'));

  // Cloud review: the code was on Grapim's server, so the line must say so.
  const hosted = await reviewChanges({ cwd: dir, base, head, config: DEFAULT_CONFIG, provider, fetchImpl: fakeFetch(() => []), hosted: true });
  assert.ok(!hosted.summary.includes('Grapim received nothing'));
  assert.ok(hosted.summary.endsWith("This review ran on Grapim's server: the code was fetched into a temporary folder there, sent only to the Anthropic API, and deleted when the review ended."));
});
