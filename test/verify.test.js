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

test('a big review still sends every finding in full; only the code around them is cut', () => {
  const big = 'x'.repeat(200) + '\n';
  const file = big.repeat(400);
  const findings = Array.from({ length: 15 }, (_, i) => F({ line: 10 + i * 20, title: `Finding number ${i}`, body: `Body ${i} mentions \`loadUser\`.` }));
  const git = (args) => (args[0] === 'show' ? file : args[0] === 'diff' ? big.repeat(100) : args[0] === 'grep' ? 'HEAD:src/b.js:1: loadUser()' : '');
  const text = gatherContext({ findings, git, base: 'B', head: 'HEAD' });
  assert.ok(text.length <= 125_000, `${text.length} chars`);
  for (let i = 0; i < 15; i++) {
    assert.ok(text.includes(`Title: Finding number ${i}`), `finding ${i} title`);
    assert.ok(text.includes(`<finding id="${i}">`) && text.includes(`Body ${i} mentions`), `finding ${i} body`);
  }
  assert.equal(text.split('<diff file="src/a.js">').length - 1, 1, 'the diff of a file is sent once');
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

test('the summary counts and the verdict are redone after a drop, and the drop is said once', () => {
  const before = '### Grapim Review\n\n**2 blockers, 1 warning** in 2 files.\n\n**Fix before merging:** Old one; Old two.\n\n<details><summary>Review details</summary>\n\nx\n\n</details>';
  const s = withCounts(before, [F({ severity: 'blocker', title: 'Kept blocker' })], 2);
  assert.match(s, /\*\*1 blocker\*\* in 2 files\.\n\n\*\*Fix before merging:\*\* Kept blocker\.\n\n<details>/);
  assert.doesNotMatch(s, /Old one/);
  assert.match(s, /dropped 2 findings before posting/);
  const none = withCounts('**1 blocker** in 1 file.\n\n**Fix before merging:** Gone.', [], 1);
  assert.match(none, /\*\*No problems found\*\* in 1 file\./);
  assert.doesNotMatch(none, /Fix before merging/);
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
      if (turn++ === 0) return { content: [{ type: 'tool_use', id: 't1', name: 'search', input: { pattern: 'loadUser\\(' } }, { type: 'tool_use', id: 't2', name: 'read_file', input: { path: 'src/b.js' } }], stop_reason: 'tool_use', usage: { input_tokens: 50, output_tokens: 5 } };
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
  const bodies = [];
  const looping = { send: async (b) => (bodies.push(b), { content: [{ type: 'tool_use', id: `t${bodies.length}`, name: 'list_files', input: {} }], stop_reason: 'tool_use' }) };
  const v = await verifyFindings({ findings: [F()], git: () => 'a.js', base: 'B', head: 'H', provider: looping, model: 'm', tools: true });
  assert.equal(bodies.length, 25, '24 tool rounds, then one that must answer');
  assert.deepEqual(bodies.at(-1).tool_choice, { type: 'none' }, 'the last request may not call a tool');
  assert.equal(bodies[0].tool_choice, undefined);
  assert.equal(v.kept.length, 1, 'no verdict keeps the finding');
  // Cache breakpoints: system, the context message, the newest tool results; never more than 4.
  const marks = (b) => [...b.system, ...b.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []))].filter((x) => x.cache_control).length;
  for (const b of bodies) assert.ok(marks(b) <= 4, `${marks(b)} breakpoints`);
  assert.ok(bodies[3].system.at(-1).cache_control && bodies[3].messages[0].content.at(-1).cache_control && bodies[3].messages.at(-1).content.at(-1).cache_control);
  assert.equal(bodies[3].messages[2].content.at(-1).cache_control, undefined, 'older tool results carry no breakpoint');
});

test('a search with an invalid pattern says so instead of "No matches"', async () => {
  const { runRepoTool } = await import('../src/airev/repo-tools.js');
  assert.match(runRepoTool(() => null, 'H', 'search', { pattern: 'loadUser(' }), /not a valid extended regular expression/);
  assert.match(runRepoTool(() => null, 'H', 'search', { pattern: 'loadUser\\(' }), /^No matches/);
  assert.match(runRepoTool(() => { throw new Error('git grep: spawnSync git ETIMEDOUT'); }, 'H', 'search', { pattern: 'x' }), /The tool failed/);
});

test('repository tools refuse paths outside the repository', async () => {
  const { runRepoTool } = await import('../src/airev/repo-tools.js');
  const git = () => 'x';
  assert.match(runRepoTool(git, 'H', 'read_file', { path: '../etc/passwd' }), /Give a file path/);
  assert.match(runRepoTool(git, 'H', 'search', { pattern: 'x', path: '--output=/tmp/x' }), /not allowed/);
  assert.match(runRepoTool(git, 'H', 'nope', {}), /No tool/);
});

test('after the second look: keep posts, drop hides, unsure posts only a blocker or a traced finding', async () => {
  const { afterSecondLook } = await import('../src/airev/verify.js');
  assert.equal(afterSecondLook(F(), 'keep'), 'post');
  assert.equal(afterSecondLook(F(), 'drop'), 'drop');
  assert.equal(afterSecondLook(F(), 'unsure'), 'drop');
  assert.equal(afterSecondLook(F({ confidence: 'high' }), 'unsure'), 'post');
  assert.equal(afterSecondLook(F({ severity: 'blocker' }), 'unsure'), 'post');
  assert.equal(afterSecondLook(F(), null), 'post', 'no verdict leaves the finding as it was');
});

test('an unsure verdict hides a medium finding; the verdicts come back for every checked finding', async () => {
  const findings = [F(), F({ line: 4, title: 'Sure one', confidence: 'high' })];
  const provider = { send: async () => reply([{ id: 0, verdict: 'unsure', reason: 'Could not find the caller.' }, { id: 1, verdict: 'unsure', reason: 'Library not visible.' }]) };
  const v = await verifyFindings({ findings, git: fakeGit({}), base: 'B', head: 'H', provider, model: 'm' });
  assert.deepEqual(v.kept.map((f) => f.title), ['Sure one']);
  assert.equal(v.dropped[0].reason, 'Could not find the caller.');
  assert.deepEqual(v.verdicts.map((x) => x.verdict), ['unsure', 'unsure']);
});

test('cloud review: held points the second look confirms are posted, the rest leave the summary', async () => {
  const { afterCheck } = await import('../src/hub/github/cloud-review-worker.js');
  const { WORTH_RE } = await import('../src/airev/findings.js');
  const posted = [F({ title: 'Posted, kept' }), F({ line: 7, title: 'Posted, dropped' })];
  const held = [F({ line: 9, confidence: 'low', title: 'Held, confirmed' }), F({ line: 11, confidence: 'low', title: 'Held, unsure' }), F({ line: 13, confidence: 'low', title: 'Held, not checked' })];
  const v = { kept: [posted[0], held[0], held[1], held[2]], verdicts: [{ finding: posted[0], verdict: 'keep' }, { finding: posted[1], verdict: 'drop' }, { finding: held[0], verdict: 'keep' }, { finding: held[1], verdict: 'unsure' }] };
  const { posted: out, removed } = afterCheck(posted, held, v);
  assert.deepEqual(out.map((f) => f.title).sort(), ['Held, confirmed', 'Posted, kept']);
  assert.equal(removed, 1);
  const summary = '**1 warning** in 1 file.\n\n**Worth a look** (2 points the review could not confirm from the code it saw, not posted inline)\n- <code>a</code> line 9: x\n- <code>a</code> line 11: y\n\n<details><summary>Review details</summary>';
  assert.equal(summary.replace(WORTH_RE, ''), '**1 warning** in 1 file.\n\n<details><summary>Review details</summary>');
  assert.doesNotMatch(withCounts(summary.replace(WORTH_RE, ''), out, 0), /second look/, 'nothing dropped, nothing said');
});
