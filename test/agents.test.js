// `grapim init` for every agent with hooks, and each agent's hook payload run
// as the agent runs it: a process with JSON on stdin, in a real git repo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectAgents, isOurs, parseAgentList, setupAgent } from '../src/agents.js';
import { initCmd, isTemporaryInstall } from '../src/cli.js';
import { patchFiles, reverseEdits } from '../src/hook.js';
import { Store } from '../src/store.js';
import { resolveWorkspace } from '../src/workspace.js';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'grapim.js');
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
delete ENV.GRAPIM_STATE_DIR;
delete ENV.GRAPIM_MODE;

function repo(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grapim-agents-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore', env: ENV });
  git('init', '-q');
  for (const [name, content] of Object.entries({ 'README.md': 'hi\n', ...files })) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init');
  return dir;
}

const emptyHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'grapim-home-'));

async function init(dir, flags = {}, opts = {}) {
  const out = [];
  const err = [];
  const code = await initCmd(resolveWorkspace(dir), flags, { home: emptyHome(), bin: '/opt/grapim/bin/grapim.js', out: (s) => out.push(s), err: (s) => err.push(s), ...opts });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const readJson = (dir, rel) => JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));

function hook(from, input) {
  const args = [BIN, 'hook', ...(from ? ['--from', from] : [])];
  const r = spawnSync(process.execPath, args, { input: JSON.stringify(input), encoding: 'utf8', env: ENV });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function runs(dir) {
  const s = new Store(resolveWorkspace(dir).stateDir);
  try {
    return s.runs();
  } finally {
    s.close();
  }
}

// ---------------------------------------------------------------- init

test('init finds agents by the traces they leave in the repo or the home folder', () => {
  const dir = repo({ '.cursor/rules/a.mdc': 'x\n', 'GEMINI.md': 'g\n' });
  const home = emptyHome();
  fs.mkdirSync(path.join(home, '.codex'));
  const found = detectAgents(dir, { home });
  assert.equal(found.claude, null);
  assert.equal(found.cursor, 'found .cursor in this repo');
  assert.equal(found.gemini, 'found GEMINI.md in this repo');
  assert.equal(found.codex, 'found ~/.codex');
  assert.deepEqual(parseAgentList('Claude-Code, cursor,cursor'), ['claude', 'cursor']);
  assert.deepEqual(parseAgentList('all'), ['claude', 'codex', 'cursor', 'gemini']);
  assert.throws(() => parseAgentList('claude,windsurf'), /Unknown agent: windsurf\. Choose from claude, codex, cursor, gemini, or all\./);
});

test('with no agent found, init sets up Claude Code and says how to choose', async () => {
  const dir = repo();
  const r = await init(dir);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Claude Code {2}\.claude\/settings\.local\.json\n/);
  assert.match(r.out, /No coding agent found in this repo or your home folder, so Claude Code was set up\. To choose: grapim init --agents claude,codex,cursor,gemini/);
  assert.match(r.out, /Sign in at https:\/\/app\.grapim\.com and create a machine token/);
  assert.match(r.out, /grapim sync --watch/);
  assert.ok(!fs.existsSync(path.join(dir, '.cursor')));
  const s = readJson(dir, '.claude/settings.local.json');
  assert.equal(s.hooks.PreToolUse[0].matcher, 'Edit|Write|MultiEdit|NotebookEdit|Bash');
  assert.equal(s.hooks.PreToolUse[0].hooks[0].command, 'node "/opt/grapim/bin/grapim.js" hook');
});

test('init sets up each agent the way it reads hooks, keeps what was there, and a second run changes nothing', async () => {
  const dir = repo();
  const mine = { command: './format.sh' };
  fs.mkdirSync(path.join(dir, '.cursor'));
  fs.writeFileSync(path.join(dir, '.cursor', 'hooks.json'), JSON.stringify({ version: 1, hooks: { afterFileEdit: [mine] } }));
  fs.mkdirSync(path.join(dir, '.gemini'));
  fs.writeFileSync(path.join(dir, '.gemini', 'settings.json'), JSON.stringify({ theme: 'Dracula', hooks: { BeforeTool: [{ matcher: 'run_shell_command', hooks: [{ type: 'command', command: 'audit.sh' }] }] } }));
  fs.mkdirSync(path.join(dir, '.codex'));
  fs.writeFileSync(path.join(dir, '.codex', 'hooks.json'), '\uFEFF' + JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'policy.py' }] }] } }));

  const first = await init(dir, { agents: 'all' });
  assert.equal(first.code, 0, first.err);
  for (const name of ['Claude Code', 'Codex CLI', 'Cursor', 'Gemini CLI', 'Git']) assert.match(first.out, new RegExp(`\\n  ${name} +\\S`));
  assert.match(first.out, /Codex CLI +\.codex\/hooks\.json\. In Codex, run \/hooks once and trust them\./);
  assert.doesNotMatch(first.out, /Not found/);

  const cursor = readJson(dir, '.cursor/hooks.json');
  assert.equal(cursor.version, 1);
  assert.deepEqual(cursor.hooks.afterFileEdit, [mine, { command: 'node "/opt/grapim/bin/grapim.js" hook --from cursor', timeout: 20 }]);
  assert.deepEqual(Object.keys(cursor.hooks).sort(), ['afterFileEdit', 'beforeSubmitPrompt', 'sessionEnd']);

  const gemini = readJson(dir, '.gemini/settings.json');
  assert.equal(gemini.theme, 'Dracula');
  assert.equal(gemini.hooks.BeforeTool.length, 2);
  assert.equal(gemini.hooks.BeforeTool[0].hooks[0].command, 'audit.sh');
  assert.deepEqual(gemini.hooks.BeforeTool[1], { matcher: 'write_file|replace|run_shell_command', hooks: [{ name: 'grapim', type: 'command', command: 'node "/opt/grapim/bin/grapim.js" hook --from gemini', timeout: 20000 }] });
  assert.deepEqual(Object.keys(gemini.hooks).sort(), ['AfterTool', 'BeforeAgent', 'BeforeTool', 'SessionEnd', 'SessionStart']);

  const codex = readJson(dir, '.codex/hooks.json');
  assert.equal(codex.hooks.PreToolUse[0].hooks[0].command, 'policy.py');
  assert.equal(codex.hooks.PreToolUse[1].matcher, 'apply_patch|Edit|Write|Bash');
  assert.equal(codex.hooks.SessionEnd[0].hooks[0].timeout, 3, 'Codex caps SessionEnd hooks at 3 s');

  const before = Object.fromEntries(['.claude/settings.local.json', '.codex/hooks.json', '.cursor/hooks.json', '.gemini/settings.json'].map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));
  const second = await init(dir, { agents: 'all' });
  assert.equal(second.code, 0);
  assert.equal((second.out.match(/\(already set up\)/g) ?? []).length, 4);
  for (const [f, text] of Object.entries(before)) assert.equal(fs.readFileSync(path.join(dir, f), 'utf8'), text, `${f} is unchanged`);

  // A new install path replaces ours instead of adding a second entry.
  await init(dir, { agents: 'cursor' }, { bin: '/usr/lib/node_modules/grapim/bin/grapim.js' });
  const moved = readJson(dir, '.cursor/hooks.json').hooks.afterFileEdit;
  assert.equal(moved.length, 2);
  assert.equal(moved[1].command, 'node "/usr/lib/node_modules/grapim/bin/grapim.js" hook --from cursor');
});

test('init leaves a config that is not valid JSON alone and still sets up the rest', async () => {
  const dir = repo();
  fs.mkdirSync(path.join(dir, '.cursor'));
  const broken = '{ "version": 1, // my hooks\n "hooks": {} }';
  fs.writeFileSync(path.join(dir, '.cursor', 'hooks.json'), broken);
  const r = await init(dir, { agents: 'cursor,claude' });
  assert.equal(r.code, 0);
  assert.equal(fs.readFileSync(path.join(dir, '.cursor', 'hooks.json'), 'utf8'), broken);
  assert.match(r.err, /Cursor: .*hooks\.json is not valid JSON .*Nothing was changed: fix it, then run grapim init again\./);
  assert.match(r.out, /Claude Code/);

  const only = await init(dir, { agents: 'cursor' });
  assert.equal(only.code, 1, 'nothing but the git hooks could be set up');
});

test('files init creates stay out of git status; files that were already there are not hidden', async () => {
  const dir = repo({ '.codex/hooks.json': '{}\n' });
  fs.mkdirSync(path.join(dir, '.gemini'));
  fs.writeFileSync(path.join(dir, '.gemini', 'settings.json'), '{"theme":"x"}\n');
  const r = await init(dir, { agents: 'all' });
  assert.equal(r.code, 0, r.err);
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: dir, encoding: 'utf8', env: ENV });
  assert.doesNotMatch(status, /\.claude|\.cursor/);
  assert.match(status, /\?\? \.gemini\/settings\.json/, 'the user made it: it stays visible');
  assert.match(status, / M \.codex\/hooks\.json/);
  assert.match(r.out, /\.codex\/hooks\.json is committed in this repo and now holds a path on this machine: keep that change out of your commits\./);
  const exclude = fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8');
  await init(dir, { agents: 'all' });
  assert.equal(fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8'), exclude, 'added once');
});

test('init from npx points the hooks at a lasting install, or says how to make one', async () => {
  const npx = '/home/u/.npm/_npx/1a2b3c/node_modules/grapim/bin/grapim.js';
  assert.ok(isTemporaryInstall(npx));
  assert.ok(isTemporaryInstall('C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\1a2b\\node_modules\\grapim\\bin\\grapim.js'));
  assert.ok(!isTemporaryInstall('/usr/local/lib/node_modules/grapim/bin/grapim.js'));

  const dir = repo();
  const none = await init(dir, {}, { bin: npx, findGlobal: () => null });
  assert.equal(none.code, 1);
  assert.match(none.err, /npm install -g grapim\n {2}grapim init/);
  assert.ok(!fs.existsSync(path.join(dir, '.claude')), 'nothing written');

  const ok = await init(dir, {}, { bin: npx, findGlobal: () => '/usr/local/lib/node_modules/grapim/bin/grapim.js' });
  assert.equal(ok.code, 0, ok.err);
  assert.equal(readJson(dir, '.claude/settings.local.json').hooks.SessionEnd[0].hooks[0].command, 'node "/usr/local/lib/node_modules/grapim/bin/grapim.js" hook');
});

test('our hook entries are recognised whatever the path, quoting or agent flag', () => {
  assert.ok(isOurs({ command: 'node "C:/x y/grapim/bin/grapim.js" hook' }));
  assert.ok(isOurs({ command: "node '/opt/grapim/bin/grapim.js' hook --from codex" }));
  assert.ok(isOurs({ command: 'grapim hook' }));
  assert.ok(!isOurs({ command: 'echo grapim hooks are nice' }));
  assert.ok(!isOurs({ command: './format.sh' }));
  // setupAgent on a folder that is not a git repo writes no exclude.
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'grapim-plain-'));
  const r = setupAgent('gemini', plain, { bin: '/b.js', isGit: false });
  assert.equal(r.git, null);
  assert.ok(r.created && r.changed);
});

// ---------------------------------------------------------------- payload parsing

test('the files of a Codex patch are read from its headers', () => {
  const patch = [
    '*** Begin Patch',
    '*** Add File: src/new.ts',
    '+export {}',
    '*** Update File: src/app.ts',
    '*** Move to: src/main.ts',
    '@@',
    '-a',
    '+b',
    '*** Delete File: old.txt',
    '*** End Patch',
  ].join('\n');
  assert.deepEqual(patchFiles(patch), ['src/new.ts', 'src/app.ts', 'src/main.ts', 'old.txt']);
  assert.deepEqual(patchFiles(['apply_patch', patch.replace(/\n/g, '\r\n')]), ['src/new.ts', 'src/app.ts', 'src/main.ts', 'old.txt']);
  assert.deepEqual(patchFiles(undefined), []);
  assert.deepEqual(patchFiles({ x: 1 }), []);
});

test('the file before a Cursor edit is worked out from its edits, or not at all', () => {
  const b = (s) => Buffer.from(s, 'utf8');
  assert.deepEqual(reverseEdits(b('a\nB\nc\n'), [{ old_string: 'b', new_string: 'B' }]), { ok: true, before: b('a\nb\nc\n') });
  // In order: the second edit is undone first.
  assert.deepEqual(reverseEdits(b('x2\n'), [{ old_string: 'x0', new_string: 'x1' }, { old_string: 'x1', new_string: 'x2' }]).before, b('x0\n'));
  // A new file.
  assert.deepEqual(reverseEdits(b('new\n'), [{ old_string: '', new_string: 'new\n' }]), { ok: true, before: null });
  // CRLF on disk, LF in the edit.
  assert.deepEqual(reverseEdits(b('a\r\nB1\r\nB2\r\n'), [{ old_string: 'b1\nb2', new_string: 'B1\nB2' }]).before, b('a\r\nb1\r\nb2\r\n'));
  // Cannot be told for sure.
  assert.equal(reverseEdits(b('B\nB\n'), [{ old_string: 'b', new_string: 'B' }]).ok, false, 'two places it could be');
  assert.equal(reverseEdits(b('a\n'), [{ old_string: 'gone', new_string: '' }]).ok, false, 'a deletion leaves nothing to find');
  assert.equal(reverseEdits(b('a\n'), [{ old_string: 'x', new_string: 'y' }]).ok, false);
  assert.equal(reverseEdits(Buffer.from([0xff, 0xfe, 0x41]), [{ old_string: 'a', new_string: 'A' }]).ok, false, 'not UTF-8');
  assert.equal(reverseEdits(null, [{ old_string: 'a', new_string: 'b' }]).ok, false);
  assert.equal(reverseEdits(b('a'), []).ok, false);
});

// ---------------------------------------------------------------- hooks, per agent

test('Codex: a patch over two files is one run, with each file claimed, snapshotted and recorded', () => {
  const dir = repo({ 'src/app.ts': 'one\ntwo\nthree\n' });
  const session = '019a3c3e-7c11-7d10-a2b4-0c1d2e3f4a5b';
  const base = { session_id: session, cwd: dir, model: 'gpt-5-codex', transcript_path: null };
  assert.equal(hook('codex', { ...base, hook_event_name: 'SessionStart', source: 'startup' }).code, 0);
  assert.equal(hook('codex', { ...base, hook_event_name: 'UserPromptSubmit', turn_id: 't1', prompt: 'Rename two to TWO\nand add a helper' }).code, 0);
  const patch = '*** Begin Patch\n*** Update File: src/app.ts\n@@\n one\n-two\n+TWO\n three\n*** Add File: src/helper.ts\n+export const h = 1;\n*** End Patch\n';
  const call = { ...base, turn_id: 't1', tool_name: 'apply_patch', tool_use_id: 'call_1', tool_input: { command: patch } };
  const pre = hook('codex', { ...call, hook_event_name: 'PreToolUse' });
  assert.equal(pre.code, 0, pre.stderr);
  fs.writeFileSync(path.join(dir, 'src', 'app.ts'), 'one\nTWO\nthree\n');
  fs.writeFileSync(path.join(dir, 'src', 'helper.ts'), 'export const h = 1;\n');
  const post = hook('codex', { ...call, hook_event_name: 'PostToolUse', tool_response: 'Success' });
  assert.equal(post.code, 0, post.stderr);
  assert.equal(post.stderr, '');

  const [run] = runs(dir);
  assert.equal(run.run, `codex:${session}`);
  assert.equal(run.label, 'codex 019a3c3e');
  assert.equal(run.intent, 'Rename two to TWO');
  assert.equal(run.files, 2);
  assert.deepEqual([run.added, run.removed], [2, 1]);

  // Another agent holding a file blocks the whole patch, with the reason on stderr.
  hook(null, { hook_event_name: 'PreToolUse', session_id: 'aaaa1111', cwd: dir, tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src', 'other.ts') } });
  const other = { ...call, session_id: 'second', tool_use_id: 'call_2', tool_input: { command: '*** Begin Patch\n*** Update File: src/other.ts\n*** End Patch' } };
  const blocked = hook('codex', { ...other, hook_event_name: 'PreToolUse' });
  assert.equal(blocked.code, 2);
  assert.match(blocked.stderr, /src\/other\.ts is claimed by another agent, claude aaaa1111/);
  // Shell commands are not edits Grapim can see.
  assert.equal(hook('codex', { ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'c3', tool_input: { command: 'ls' } }).code, 0);
  assert.equal(hook('codex', { ...base, hook_event_name: 'SessionEnd', reason: 'other' }).code, 0);
});

test('Cursor: afterFileEdit records the edit against the file as it was before', () => {
  const dir = repo({ 'src/app.ts': 'one\ntwo\nthree\n' });
  const base = { conversation_id: 'c0ffee00-1111-2222-3333-444455556666', generation_id: 'g1', model: 'x', cursor_version: '2.1.0', workspace_roots: [dir], user_email: null, transcript_path: null };
  const p = hook('cursor', { ...base, hook_event_name: 'beforeSubmitPrompt', prompt: 'Make two loud', attachments: [] });
  assert.equal(p.code, 0, p.stderr);
  assert.deepEqual(JSON.parse(p.stdout), { continue: true });

  fs.writeFileSync(path.join(dir, 'src', 'app.ts'), 'one\nTWO\nthree\n');
  const e = hook('cursor', { ...base, hook_event_name: 'afterFileEdit', file_path: path.join(dir, 'src', 'app.ts'), edits: [{ old_string: 'two', new_string: 'TWO' }] });
  assert.equal(e.code, 0, e.stderr);
  assert.equal(e.stdout, '');
  fs.writeFileSync(path.join(dir, 'src', 'new.ts'), 'x\n');
  hook('cursor', { ...base, hook_event_name: 'afterFileEdit', file_path: path.join(dir, 'src', 'new.ts'), edits: [{ old_string: '', new_string: 'x\n' }] });

  const [run] = runs(dir);
  assert.equal(run.run, 'cursor:c0ffee00-1111-2222-3333-444455556666');
  assert.equal(run.label, 'cursor c0ffee00');
  assert.equal(run.intent, 'Make two loud');
  assert.equal(run.files, 2);
  assert.deepEqual([run.added, run.removed], [2, 1], 'one changed line, one new line');

  // An edit that cannot be undone for sure is logged, not attributed, and never blocks.
  fs.writeFileSync(path.join(dir, 'README.md'), 'B\nB\n');
  const amb = hook('cursor', { ...base, hook_event_name: 'afterFileEdit', file_path: path.join(dir, 'README.md'), edits: [{ old_string: 'b', new_string: 'B' }] });
  assert.equal(amb.code, 0);
  assert.match(amb.stderr, /could not tell what README\.md held before this edit/);
  assert.equal(runs(dir)[0].files, 2);
  assert.equal(hook('cursor', { ...base, hook_event_name: 'sessionEnd', session_id: 's', reason: 'completed' }).code, 0);
});

test('Gemini CLI: write_file and replace are recorded, stdout is only JSON, a held file is refused', () => {
  const dir = repo({ 'app.py': 'a = 1\n' });
  const base = { session_id: 'gem-session-1', transcript_path: null, cwd: dir, timestamp: new Date().toISOString() };
  const start = hook('gemini', { ...base, hook_event_name: 'SessionStart', source: 'startup' });
  assert.equal(start.code, 0, start.stderr);
  assert.deepEqual(JSON.parse(start.stdout), {});
  assert.deepEqual(JSON.parse(hook('gemini', { ...base, hook_event_name: 'BeforeAgent', prompt: 'Set a to 2' }).stdout), {});

  const call = { ...base, tool_name: 'replace', tool_input: { file_path: 'app.py', old_string: 'a = 1', new_string: 'a = 2', instruction: 'x' } };
  assert.deepEqual(JSON.parse(hook('gemini', { ...call, hook_event_name: 'BeforeTool' }).stdout), {});
  fs.writeFileSync(path.join(dir, 'app.py'), 'a = 2\n');
  assert.equal(hook('gemini', { ...call, hook_event_name: 'AfterTool', tool_response: {} }).code, 0);
  const [run] = runs(dir);
  assert.equal(run.run, 'gemini:gem-session-1');
  assert.equal(run.intent, 'Set a to 2');
  assert.deepEqual([run.added, run.removed], [1, 1]);

  // Another session holds app.py: exit 2 with the reason on stderr, and no stdout.
  const other = hook('gemini', { ...call, session_id: 'gem-session-2', hook_event_name: 'BeforeTool' });
  assert.equal(other.code, 2);
  assert.equal(other.stdout, '');
  assert.match(other.stderr, /app\.py is claimed by another agent, gemini /);
  // Other agents' activity is not sent as plain text, which Gemini CLI cannot parse.
  const prompt2 = hook('gemini', { ...base, session_id: 'gem-session-2', hook_event_name: 'BeforeAgent', prompt: 'hello' });
  assert.deepEqual(JSON.parse(prompt2.stdout), {});
});

test('an unknown --from is read as Claude Code, and a Node older than 22.13 gets a clear message', () => {
  const dir = repo();
  assert.equal(hook('windsurf', { hook_event_name: 'UserPromptSubmit', session_id: 'abcd0000', cwd: dir, prompt: 'p' }).code, 0);
  assert.equal(runs(dir).length, 0);
  const s = new Store(resolveWorkspace(dir).stateDir);
  assert.equal(s.turn('claude-code:abcd0000'), 1);
  s.close();

  const pre = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'grapim-node-')), 'old-node.cjs');
  fs.writeFileSync(pre, "Object.defineProperty(process, 'versions', { value: { ...process.versions, node: '20.11.1' } });\n");
  const r = spawnSync(process.execPath, ['--require', pre, BIN, '--version'], { encoding: 'utf8', env: ENV });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^grapim needs Node\.js 22\.13 or newer, and this is Node 20\.11\.1\.\nInstall the current LTS from https:\/\/nodejs\.org/);
  const ok = spawnSync(process.execPath, [BIN, '--version'], { encoding: 'utf8', env: ENV });
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /^\d+\.\d+\.\d+\n$/);
});

test('the CLI refuses an unknown command or option with a pointer, and shows one command\'s help', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grapim-cli-ux-'));
  const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: 'utf8', env: ENV });
  const typo = run('rnus');
  assert.equal(typo.status, 1);
  assert.equal(typo.stdout, '');
  assert.match(typo.stderr, /^Unknown command: rnus\. Did you mean grapim runs\? See grapim --help/);
  const flag = run('init', '--bogus');
  assert.equal(flag.status, 1);
  assert.match(flag.stderr, /^grapim init has no option --bogus\. It takes --agents, --no-intents\./);
  assert.ok(!fs.existsSync(path.join(dir, '.claude')), 'init did not run');
  const one = run('undo', '--help');
  assert.equal(one.status, 0);
  assert.match(one.stdout, /^Usage:\n {2}grapim undo <run> \[--turn N\] \[--yes\]\n/);
  assert.doesNotMatch(one.stdout, /grapim sync/);
});
