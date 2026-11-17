// The second look before posting (src/airev/verify.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gatherContext, namesIn, verifyFindings } from '../src/airev/verify.js';
import { withCounts } from '../src/hub/github/cloud-review-worker.js';

const F = (over) => ({ path: 'src/a.js', line: 3, severity: 'warning', confidence: 'medium', title: 'Uses `loadUser` without a check', body: 'If `loadUser` returns null, `user.name` throws.', ...over });
const fakeGit = (files) => (args) => {
  if (args[0] === 'show') return files[args[1].split(':')[1]] ?? null;
  if (args[0] === 'log') return '--- abc123 Add the name field\nThe caller guarantees a user.';
  if (args[0] === 'diff') return '@@ -1,2 +1,3 @@\n+const x = loadUser();';
  if (args[0] === 'grep') return `HEAD:src/b.js:10:  loadUser(id) ?? DEFAULT`;
  return null;
};
const reply = (verdicts) => ({ content: [{ type: 'text', text: JSON.stringify({ verdicts }) }], usage: { input_tokens: 100, output_tokens: 20 } });

test('names to look up come from backticks, last segment, no short words', () => {
  assert.deepEqual(namesIn(F({ title: 'x', body: 'See `this.cache.lookup` and `ok` and `loadUser`.' })), ['lookup', 'loadUser']);
  assert.ok(namesIn(F()).includes('loadUser'));
  assert.ok(!namesIn(F({ title: 'x', body: '`ok`' })).includes('ok'));
});

test('context carries the commits, the discussion, the diff, the file around the line and the uses', () => {
  const text = gatherContext({ findings: [F()], git: fakeGit({ 'src/a.js': 'a\nb\nconst x = loadUser();\nd' }), base: 'B', head: 'HEAD', discussion: 'author: loadUser never returns null here' });
  for (const part of ['<commits>', 'caller guarantees', '<discussion>', 'never returns null', '<diff file="src/a.js">', '<file path="src/a.js"', '3  const x = loadUser();', '<uses name="loadUser">', 'src/b.js:10']) assert.ok(text.includes(part), part);
});

test('drops what the model rejects with a reason, keeps the rest, counts tokens', async () => {
  const findings = [F(), F({ line: 4, title: 'Second', severity: 'blocker' }), F({ line: 5, title: 'Third' })];
  const sent = [];
  const provider = { send: async (body) => (sent.push(body), reply([{ id: 0, verdict: 'drop', reason: 'The discussion says loadUser never returns null.' }, { id: 1, verdict: 'drop', reason: '' }, { id: 2, verdict: 'keep', reason: 'Supported.' }])) };
  const v = await verifyFindings({ findings, git: fakeGit({}), base: 'B', head: 'H', provider, model: 'm', request: { title: 'Add name', body: 'Shows the name' } });
  assert.deepEqual(v.kept.map((f) => f.title), ['Second', 'Third'], 'a drop without a reason is ignored');
  assert.equal(v.dropped.length, 1);
  assert.match(v.dropped[0].reason, /never returns null/);
  assert.deepEqual(v.usage, { input: 100, output: 20 });
  assert.match(sent[0].messages[0].content[0].text, /The pull request says it does this:\nAdd name/);
  assert.equal(sent[0].output_config.format.type, 'json_schema');
});

test('a failed or unreadable answer keeps every finding', async () => {
  const findings = [F(), F({ line: 9 })];
  const boom = await verifyFindings({ findings, git: fakeGit({}), base: 'B', head: 'H', provider: { send: async () => { throw new Error('503'); } }, model: 'm' });
  assert.equal(boom.kept.length, 2);
  const junk = await verifyFindings({ findings, git: fakeGit({}), base: 'B', head: 'H', provider: { send: async () => ({ content: [{ type: 'text', text: 'not json' }] }) }, model: 'm' });
  assert.equal(junk.kept.length, 2);
  assert.equal((await verifyFindings({ findings: [], git: fakeGit({}), base: 'B', head: 'H', provider: {}, model: 'm' })).kept.length, 0);
});

test('the summary counts are redone after a drop, and the drop is said once', () => {
  const s = withCounts('### Grapim Review\n\n**2 blockers, 1 warning, 0 nits** in 2 files.', [F({ severity: 'blocker' })], 2);
  assert.match(s, /\*\*1 blocker, 0 warnings, 0 nits\*\* in 2 files\./);
  assert.match(s, /dropped 2 findings before posting/);
  assert.match(withCounts('**1 blocker, 0 warnings, 0 nits**', [], 1), /\*\*No problems found\*\*/);
});

test('with tools, the model can search the repository before its verdicts', async () => {
  const { REPO_TOOLS } = await import('../src/airev/repo-tools.js');
  const calls = [];
  const git = (args) => (calls.push(args), args[0] === 'grep' ? 'H:src/b.js:10:  if (!user) return DEFAULT;' : args[0] === 'show' && args[1] === 'H:src/b.js' ? 'a\nb' : null);
  const sent = [];
  let turn = 0;
  const provider = {
    send: async (body) => {
      sent.push(body);
      if (turn++ === 0) return { content: [{ type: 'tool_use', id: 't1', name: 'search', input: { pattern: 'loadUser\(' } }, { type: 'tool_use', id: 't2', name: 'read_file', input: { path: 'src/b.js' } }], stop_reason: 'tool_use', usage: { input_tokens: 50, output_tokens: 5 } };
      return { ...reply([{ id: 0, verdict: 'drop', reason: 'src/b.js:10 returns DEFAULT when there is no user.' }]), stop_reason: 'end_turn' };
    },
  };
  const v = await verifyFindings({ findings: [F()], git, base: 'B', head: 'H', provider, model: 'm', tools: true });
  assert.deepEqual(sent[0].tools.map((t) => t.name), REPO_TOOLS.map((t) => t.name));
  assert.match(sent[0].system[0].text, /search and read the whole repository/);
  const results = sent[1].messages.at(-1).content;
  assert.equal(results[0].tool_use_id, 't1');
  assert.match(results[0].content, /^src\/b\.js:10:/, 'the head prefix is cut');
  assert.match(results[1].content, /1  a/);
  assert.ok(calls.some((a) => a[0] === 'grep' && a.includes('-E') && a.includes('H')));
  assert.equal(v.dropped.length, 1);
  assert.equal(v.searches, 2);
  assert.deepEqual(v.usage, { input: 150, output: 25 });
});

test('without tools no tool is offered, and the tool rounds are capped', async () => {
  const plain = [];
  await verifyFindings({ findings: [F()], git: fakeGit({}), base: 'B', head: 'H', provider: { send: async (b) => (plain.push(b), reply([])) }, model: 'm' });
  assert.equal(plain[0].tools, undefined);
  assert.doesNotMatch(plain[0].system[0].text, /tools/);
  let n = 0;
  const looping = { send: async () => (n++, { content: [{ type: 'tool_use', id: `t${n}`, name: 'list_files', input: {} }], stop_reason: 'tool_use' }) };
  const v = await verifyFindings({ findings: [F()], git: () => 'a.js', base: 'B', head: 'H', provider: looping, model: 'm', tools: true });
  assert.ok(n <= 26, `stopped after ${n} requests`);
  assert.equal(v.kept.length, 1, 'no verdict keeps the finding');
});

test('repository tools refuse paths outside the repository', async () => {
  const { runRepoTool } = await import('../src/airev/repo-tools.js');
  const git = () => 'x';
  assert.match(runRepoTool(git, 'H', 'read_file', { path: '../etc/passwd' }), /Give a file path/);
  assert.match(runRepoTool(git, 'H', 'search', { pattern: 'x', path: '--output=/tmp/x' }), /not allowed/);
  assert.match(runRepoTool(git, 'H', 'nope', {}), /No tool/);
});
