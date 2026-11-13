// Manager reports (docs/provenance.md section 7): each report's numbers on a
// small fixture worked out by hand, human = added - AI in recorded commits and
// unrecorded lines never counted as human, filters,
// CSV, plan gating, tenant isolation, the cache, and the governance plan in
// billing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHub } from '../src/hub/server.js';
import { CHECKOUT_PLANS, createBilling, featuresFor, limitsFor, PLANS } from '../src/hub/billing.js';
import { makeLimits } from '../src/hub/plans.js';
import { kindOf, labelPrefix, parseNote } from '../src/hub/reports/notes.js';
import { REPORTS } from '../src/hub/reports/index.js';

const ORIGIN = 'http://localhost:7999';
const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 11, 12, 0, 0); // Wednesday 11 Nov 2026
const at = (iso) => Date.parse(iso);
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// ---------------------------------------------------------------- a hub

function fakeGitHub() {
  const codes = new Map();
  const fetch = async (url, init = {}) => {
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url === 'https://github.com/login/oauth/access_token') {
      const { code } = JSON.parse(init.body);
      return codes.has(code) ? reply(200, { access_token: `gho_${code}` }) : reply(200, { error: 'bad_verification_code' });
    }
    if (url === 'https://api.github.com/user') {
      const u = codes.get(String(init.headers?.Authorization || '').replace('Bearer gho_', ''));
      return u ? reply(200, u) : reply(401, {});
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { fetch, user: (code, profile) => codes.set(code, profile) };
}

async function startHub() {
  const gh = fakeGitHub();
  const clock = { t: NOW };
  const hub = await createHub({
    env: { HUB_URL: ORIGIN, HUB_SECRET: 'test-secret-that-is-long-enough-0123456789', HUB_DATA: tmp('grapim-reports-'), GITHUB_CLIENT_ID: 'gh-client', GITHUB_CLIENT_SECRET: 'gh-secret' },
    fetch: gh.fetch,
    log: () => {},
    billing: null,
    now: () => clock.t,
  });
  const addr = await hub.listen(0, '127.0.0.1');
  return { hub, gh, clock, base: `http://127.0.0.1:${addr.port}`, close: () => hub.close() };
}

class Browser {
  constructor(base) {
    this.base = base;
    this.jar = new Map();
  }
  async req(p, { method = 'GET', form = null } = {}) {
    const h = {};
    if (this.jar.size) h.Cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (method !== 'GET') h.Origin = ORIGIN;
    let body;
    if (form) {
      h['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    }
    const res = await fetch(this.base + p, { method, headers: h, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      if (/Max-Age=0/i.test(c) || pair.slice(i + 1) === '') this.jar.delete(pair.slice(0, i));
      else this.jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, json: () => JSON.parse(text) };
  }
  async post(p, form = {}) {
    const csrf = (await this.req('/hub/api/me')).json().csrf;
    return this.req(p, { method: 'POST', form: { _csrf: csrf, ...form } });
  }
}

let nextId = 9000;
async function signIn(h, login) {
  const id = nextId++;
  h.gh.user(`code-${id}`, { id, login, name: login, avatar_url: null });
  const b = new Browser(h.base);
  const start = await b.req('/hub/auth/github');
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  assert.equal((await b.req(`/hub/auth/callback?code=code-${id}&state=${state}`)).status, 303);
  return b;
}

async function createTeam(b, name) {
  const r = await b.post('/hub/teams', { name });
  assert.equal(r.status, 303, r.text);
  return r.headers.get('location').match(/\/hub\/teams\/([^/?#]+)/)[1];
}

// ---------------------------------------------------------------- the fixture

const R1 = sha1('alpha root');
const R2 = sha1('beta root');
const R3 = sha1('gamma root');

function rows(db, team) {
  const t = NOW - 30 * 24 * HOUR;
  const ids = new Map();
  const next = (k) => {
    ids.set(k, (ids.get(k) ?? 0) + 1);
    return ids.get(k);
  };
  return {
    repo: (id, name) => db.prepare('INSERT INTO repos (team_id, id, name, created_at, last_sync_at) VALUES (?, ?, ?, ?, ?)').run(team, id, name, t, t),
    machine: (repo, machine) => db.prepare('INSERT INTO machines (team_id, repo_id, machine, user_id, token_id, last_sync_at) VALUES (?, ?, ?, 1, ?, ?)').run(team, repo, machine, 'tok', t),
    note: (repo, sha, note, received) => db.prepare('INSERT INTO h_provenance (team_id, repo_id, commit_sha, note_json, received_at) VALUES (?, ?, ?, ?, ?)').run(team, repo, sha, typeof note === 'string' ? note : JSON.stringify(note), received),
    change: (repo, machine, run, label, file, added, ts) =>
      db.prepare(
        `INSERT INTO h_changes (team_id, repo_id, machine, local_id, run, label, turn, worktree, path, before_sha, after_sha, untracked, added, removed, ts)
         VALUES (?, ?, ?, ?, ?, ?, 1, 'wt', ?, NULL, NULL, 0, ?, 0, ?)`,
      ).run(team, repo, machine, next(`c${repo}${machine}`), run, label, file, added, ts),
    agent: (repo, machine, run, label) => db.prepare('INSERT INTO h_agents (team_id, repo_id, machine, agent, label, intent, worktree, last_seen) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)').run(team, repo, machine, run, label, 'wt', t),
    event: (repo, machine, ts, agent, kind, file, detail) =>
      db.prepare('INSERT INTO h_events (team_id, repo_id, machine, local_id, ts, agent, kind, path, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(team, repo, machine, next(`e${repo}${machine}`), ts, agent, kind, file, detail),
  };
}

const run = (id, label, extra = {}) => ({ id, label, kind: kindOf(id), turns: [{ turn: 1, intent: `${label} work` }], ...extra });

// Hand-checked numbers for 2026-10-26 .. 2026-11-08 (weeks of Oct 26 and Nov 2):
//   n1 alpha  Nov 3  added 100: claude aaa 32 lines (a.js 30, b.js 2 after the overlap), codex 7 10 lines
//   n2 alpha  Oct 28 added 50: no agent lines (a person's commit)
//   n3 beta   Nov 4  no total: claude bbb 5 lines
//   n4 beta   no commit block (dated by upload, Nov 5): cursor 9 8 lines, rejected in the note
//   n5 alpha  Sep 1 (out of range)
//   n6 beta   not a note
//   n7 alpha  Nov 5  added 10, not on the default branch: claude ccc 4 lines, folder sync 5 lines
function seed(db, team) {
  const x = rows(db, team);
  x.repo(R1, 'alpha');
  x.repo(R2, 'beta');
  x.repo(R3, 'gamma');
  x.machine(R1, 'box');
  x.note(R1, sha1('n1'), { v: 1, runs: [run('claude-code:aaa', 'claude aaaaaaaa'), run('codex-mcp-client:7', 'codex 7')], files: { 'a.js': [[1, 30, 0, 1]], 'b.js': [[1, 10, 1, 1], [5, 12, 0, 1]] }, commit: { ts: at('2026-11-03T10:00:00Z'), added: 100 } }, at('2026-11-03T11:00:00Z'));
  x.note(R1, sha1('n2'), { v: 1, runs: [], files: {}, commit: { ts: at('2026-10-28T10:00:00Z'), added: 50, default_branch: true } }, at('2026-10-28T11:00:00Z'));
  x.note(R2, sha1('n3'), { v: 1, runs: [run('claude-code:bbb', 'claude bbbbbbbb')], files: { 'c.js': [[21, 25, 0, 1]] }, commit: { ts: at('2026-11-04T10:00:00Z') } }, at('2026-11-04T11:00:00Z'));
  x.note(R2, sha1('n4'), { v: 1, runs: [run('cursor-vscode:9', '=HYPERLINK("http://x")', { review: 'rejected' })], files: { 'd.js': [[1, 8, 0, 1]] } }, at('2026-11-05T09:00:00Z'));
  x.note(R1, sha1('n5'), { v: 1, runs: [run('claude-code:old', 'claude old')], files: { 'z.js': [[1, 99, 0, 1]] }, commit: { ts: at('2026-09-01T10:00:00Z'), added: 99 } }, at('2026-10-27T10:00:00Z'));
  x.note(R2, sha1('n6'), 'not json {', at('2026-11-02T10:00:00Z'));
  x.note(R1, sha1('n7'), { v: 1, runs: [run('claude-code:ccc', 'claude cccccccc', { review: 'approved' }), run('http:sync-laptop', 'sync-laptop')], files: { 'e.js': [[1, 4, 0, 1], [5, 9, 1, 1]] }, commit: { ts: at('2026-11-05T10:00:00Z'), added: 10, default_branch: false } }, at('2026-11-05T11:00:00Z'));

  // Synced runs (alpha, machine box).
  x.agent(R1, 'box', 'claude-code:aaa', 'claude aaaaaaaa');
  x.change(R1, 'box', 'claude-code:aaa', 'claude aaaaaaaa', 'a.js', 30, at('2026-11-03T09:00:00Z'));
  x.change(R1, 'box', 'claude-code:aaa', 'claude aaaaaaaa', 'b.js', 5, at('2026-11-03T09:30:00Z'));
  x.event(R1, 'box', at('2026-11-03T11:30:00Z'), 'claude-code:aaa', 'review', null, 'approved');
  x.change(R1, 'box', 'codex-mcp-client:7', 'codex 7', 'b.js', 12, at('2026-11-03T08:00:00Z'));
  x.change(R1, 'box', 'claude-code:ddd', 'claude dddddddd', 'c2.js', 10, at('2026-11-04T10:00:00Z'));
  x.event(R1, 'box', at('2026-11-04T14:00:00Z'), 'claude-code:ddd', 'review', null, 'rejected: no tests');
  x.change(R1, 'box', 'undo:1762265400000', 'undo claude dddddddd', 'c2.js', 0, at('2026-11-04T14:10:00Z'));
  x.change(R1, 'box', 'http:sync-laptop', 'sync-laptop', 'x.md', 3, at('2026-11-04T15:00:00Z'));
  x.event(R1, 'box', at('2026-11-04T09:59:00Z'), 'claude-code:ddd', 'blocked', 'b.js', 'held by codex 7');
  x.change(R1, 'box', 'claude-code:old', 'claude old', 'z.js', 99, at('2026-09-01T09:00:00Z')); // out of range
}

const RANGE = 'from=2026-10-26&to=2026-11-08';

async function setup(t) {
  const h = await startHub();
  t.after(h.close);
  const alice = await signIn(h, 'alice');
  const A = await createTeam(alice, 'Alpha Co');
  h.hub.db.prepare("UPDATE teams SET plan = 'governance' WHERE id = ?").run(A);
  seed(h.hub.db, A);
  return { h, alice, A };
}

// ---------------------------------------------------------------- notes

test('notes: kinds from run ids, label prefixes, overlapping ranges counted once, junk refused', () => {
  assert.equal(kindOf('claude-code:1a2b'), 'claude-code');
  assert.equal(kindOf('codex-mcp-client:44'), 'codex');
  assert.equal(kindOf('cursor-vscode:9'), 'cursor');
  assert.equal(kindOf('mcp:1'), 'mcp');
  assert.equal(kindOf('http:sandbox-2'), 'http');
  assert.equal(kindOf('http:sync-laptop'), 'sync');
  assert.equal(kindOf('sync-laptop'), 'sync');
  assert.equal(kindOf('undo:1'), 'undo');
  assert.equal(kindOf('restore:1'), 'restore');
  assert.equal(labelPrefix('claude 1a2b3c4d'), 'claude');
  assert.equal(labelPrefix('sandbox-12'), 'sandbox');
  assert.equal(labelPrefix('ci-bot-7f3a'), 'ci-bot');

  const n = parseNote(JSON.stringify({ runs: [run('claude-code:a', 'claude a'), run('codex-mcp-client:1', 'codex 1')], files: { 'x.js': [[1, 10, 1, 1], [5, 12, 0, 1], [3, 4, 0, 1]] }, commit: { ts: 5, added: 3 } }));
  assert.equal(n.runs[1].lines, 10);
  assert.equal(n.runs[0].lines, 2);
  assert.equal(n.ai, 12);
  assert.equal(n.added, 12, 'a total below the attributed lines is widened, never negative unknown');
  assert.equal(n.inconsistent, true);
  for (const junk of ['nope', '[]', '{"runs":{}}', '{"files":[]}']) assert.equal(parseNote(junk), null, junk);
  // Ranges pointing at no run, backwards or absurd are skipped.
  assert.equal(parseNote(JSON.stringify({ runs: [run('claude-code:a', 'a')], files: { f: [[5, 1, 0, 1], [1, 2, 7, 1], [-1, 3, 0, 1], [1, 2e9, 0, 1]] } })).ai, 0);
});

// ---------------------------------------------------------------- the numbers

test('ai-share: weekly AI and human lines, share over recorded commits, coverage', async (t) => {
  const { alice, A } = await setup(t);
  const r = (await alice.req(`/hub/api/teams/${A}/reports/ai-share?${RANGE}`)).json();
  assert.equal(r.report, 'ai-share');
  assert.deepEqual(r.range, { from: '2026-10-26', to: '2026-11-08', history_from: '2025-11-11', clamped: false });
  assert.deepEqual(r.totals, {
    commits: 5,
    commits_with_totals: 3,
    ai: 59,
    added: 160,
    human: 114,
    by_kind: { 'claude-code': 41, codex: 10, cursor: 8 },
    ai_in_share: 46,
    share: 46 / 160,
  });
  assert.deepEqual(r.kinds, ['claude-code', 'codex', 'cursor']);
  assert.deepEqual(
    r.weeks.map((w) => [w.week, w.commits, w.ai, w.human, w.added]),
    [
      ['2026-10-26', 1, 0, 50, 50],
      ['2026-11-02', 4, 59, 64, 110],
    ],
  );
  assert.equal(r.weeks[0].share, 0);
  assert.equal(r.weeks[1].share, 46 / 110);
  assert.deepEqual(
    r.repos.map((x) => [x.name, x.commits, x.ai, x.added, x.share]),
    [
      ['alpha', 3, 46, 160, 46 / 160],
      ['beta', 2, 13, 0, null],
    ],
  );
  const c = r.coverage;
  assert.equal(c.repos_total, 3);
  assert.equal(c.repos_with_provenance, 2);
  assert.deepEqual(c.repos_without_provenance, ['gamma']);
  assert.equal(c.commits_without_agent_lines, 1);
  assert.equal(c.dated_by_upload, 1);
  assert.equal(c.notes_invalid, 1);
  assert.equal(c.truncated, false);
  assert.ok(r.caveats.some((s) => /unknown, not human/.test(s)));
  assert.ok(r.caveats.some((s) => /^Not recorded: gamma \(1 of 3 repos\).*unknown/.test(s)));
  assert.ok(r.caveats.some((s) => /2 notes \(from an older Grapim\) do not say how many lines/.test(s)));
});

test('human is added minus AI in recorded commits; commits without a note stay unknown, never human', async (t) => {
  const { h, alice, A } = await setup(t);
  // gamma syncs runs but uploads no notes: its commits are not recorded.
  rows(h.hub.db, A).change(R3, 'box', 'claude-code:g', 'claude gggggggg', 'g.js', 500, at('2026-11-03T10:00:00Z'));
  const r = (await alice.req(`/hub/api/teams/${A}/reports/ai-share?${RANGE}`)).json();
  // In recorded commits every added line is AI or human, nothing else.
  for (const w of r.weeks) assert.equal(w.ai_in_share + w.human, w.added, w.week);
  assert.equal(r.totals.human, 160 - 46);
  assert.equal(r.totals.added, 160, "gamma's 500 synced lines are in no count: unknown");
  assert.deepEqual(r.coverage.repos_without_provenance, ['gamma']);
  assert.equal(r.coverage.commits_without_totals, 2);
  assert.equal(r.totals.by_kind.sync, undefined, 'folder sync is not an agent');
  // Notes without commit.added (older clients): AI counted, no human lines, no share.
  const beta = (await alice.req(`/hub/api/teams/${A}/reports/ai-share?${RANGE}&repo=${R2}`)).json();
  assert.deepEqual([beta.totals.ai, beta.totals.human, beta.totals.added, beta.totals.share], [13, 0, 0, null]);
  // n7: 10 added, 4 AI, so 6 human, 5 of them from a folder-sync run.
  const one = (await alice.req(`/hub/api/teams/${A}/reports/ai-share?from=2026-11-05&to=2026-11-05&repo=${R1}`)).json();
  assert.deepEqual([one.totals.ai, one.totals.human, one.totals.added], [4, 6, 10]);
  // The page says it in words, and shows the gap.
  const page = (await alice.req(`/hub/teams/${A}/reports/ai-share?${RANGE}`)).text;
  assert.match(page, /unknown, not human/);
  assert.match(page, /1 not recorded: unknown/);
  assert.match(page, /Not recorded, lines unknown/);
});

test('agents: runs, review, undo and reject rates, median review time, committed lines', async (t) => {
  const { alice, A } = await setup(t);
  const r = (await alice.req(`/hub/api/teams/${A}/reports/agents?${RANGE}`)).json();
  const by = Object.fromEntries(r.agents.map((g) => [g.kind, g]));
  assert.deepEqual(r.agents.map((g) => `${g.kind}|${g.prefix}`).slice(0, 2), ['claude-code|claude', 'codex|codex']);
  assert.deepEqual(Object.keys(by).sort(), ['claude-code', 'codex', 'cursor']);
  const claude = by['claude-code'];
  assert.equal(claude.runs, 2);
  assert.equal(claude.approved, 1);
  assert.equal(claude.rejected, 1);
  assert.equal(claude.reviewed, 2);
  assert.equal(claude.undone, 1);
  assert.equal(claude.undo_rate, 0.5);
  assert.equal(claude.reject_rate, 0.5);
  assert.equal(claude.median_review_ms, 3 * HOUR, '2 h and 4 h');
  assert.equal(claude.lines_written, 45);
  assert.equal(claude.lines_committed, 41);
  const codex = by.codex;
  assert.deepEqual([codex.runs, codex.pending, codex.reviewed, codex.reject_rate, codex.median_review_ms, codex.lines_committed], [1, 1, 0, null, null, 10]);
  assert.deepEqual([by.cursor.runs, by.cursor.lines_committed], [0, 8]);
  assert.deepEqual(r.excluded, { sync: 1, undo: 1, restore: 0 });
  assert.equal(r.totals.runs, 3);
  assert.equal(r.totals.undo_rate, 1 / 3);
});

test('unreviewed: AI lines from runs not approved, the newest review event wins, other branches left out', async (t) => {
  const { alice, A } = await setup(t);
  const r = (await alice.req(`/hub/api/teams/${A}/reports/unreviewed?${RANGE}`)).json();
  assert.deepEqual(
    r.runs.map((u) => [u.run, u.status, u.lines, u.commits]),
    [
      ['codex-mcp-client:7', 'pending', 10, 1],
      ['cursor-vscode:9', 'rejected', 8, 1],
      ['claude-code:bbb', 'pending', 5, 1],
    ],
  );
  assert.equal(r.totals.lines, 23);
  assert.equal(r.totals.pending_lines, 15);
  assert.equal(r.totals.rejected_lines, 8);
  assert.equal(r.totals.ai_lines, 55, 'claude aaa (approved by an event, though its note says pending) is in the AI lines, not the unreviewed ones');
  assert.equal(r.coverage.not_on_default_branch, 1);
  assert.equal(r.coverage.branch_unknown, 3);
  assert.ok(r.caveats.some((s) => /3 of 4 commits do not say whether they are on the default branch/.test(s)));
});

test('activity: runs, files, blocks and conflicts per day', async (t) => {
  const { alice, A } = await setup(t);
  const r = (await alice.req(`/hub/api/teams/${A}/reports/activity?${RANGE}`)).json();
  assert.equal(r.days.length, 14);
  const day = Object.fromEntries(r.days.map((d) => [d.date, d]));
  assert.deepEqual(day['2026-11-03'], { date: '2026-11-03', start: at('2026-11-03T00:00:00Z'), runs: 2, files: 2, edits: 3, blocks: 0, conflicts: 1 });
  assert.deepEqual(day['2026-11-04'], { date: '2026-11-04', start: at('2026-11-04T00:00:00Z'), runs: 2, files: 2, edits: 2, blocks: 1, conflicts: 0 });
  assert.deepEqual(r.totals, { runs: 4, files: 4, edits: 5, blocks: 1, conflicts: 1, active_days: 2, busiest: 2 });
});

// ---------------------------------------------------------------- filters

test('filters: repo, dates, bad input, history window', async (t) => {
  const { h, alice, A } = await setup(t);
  const get = (q) => alice.req(`/hub/api/teams/${A}/reports/ai-share?${q}`);
  const beta = (await get(`${RANGE}&repo=${R2}`)).json();
  assert.equal(beta.repo, R2);
  assert.deepEqual([beta.totals.commits, beta.totals.ai], [2, 13]);
  assert.equal(beta.coverage.repos_total, 1);
  const week = (await get('from=2026-11-02&to=2026-11-08')).json();
  assert.equal(week.totals.commits, 4);
  assert.equal(week.weeks.length, 1);
  const older = (await get('from=2026-08-31&to=2026-09-06')).json();
  assert.deepEqual([older.totals.commits, older.totals.ai], [1, 99]);
  // The default range: the 12 weeks up to today.
  const def = (await alice.req(`/hub/api/teams/${A}/reports/activity`)).json();
  assert.deepEqual(def.range, { from: '2026-08-24', to: '2026-11-11', history_from: '2025-11-11', clamped: false });

  assert.equal((await get('from=2026-13-01')).status, 400);
  assert.equal((await get('from=2026-02-30')).status, 400);
  assert.equal((await get('from=2026-11-08&to=2026-11-01')).status, 400);
  assert.equal((await get('from=2024-01-01&to=2026-11-08')).status, 400, 'over 366 days');
  assert.equal((await get(`repo=${sha1('nope')}`)).status, 404);
  assert.equal((await get('repo=../../etc')).status, 404);

  // Before the plan's history window (365 days on governance) the range is clamped.
  const clampHub = (await get('from=2025-11-01&to=2025-11-30')).json();
  assert.deepEqual([clampHub.range.from, clampHub.range.clamped], ['2025-11-11', true]);

  // The page keeps working on a bad filter and says what was wrong.
  const page = await alice.req(`/hub/teams/${A}/reports/agents?from=nope`);
  assert.equal(page.status, 400);
  assert.match(page.text, /from must be a date/);
});

// ---------------------------------------------------------------- CSV

test('CSV: every report, quoted, no formula injection, same numbers as the JSON', async (t) => {
  const { alice, A } = await setup(t);
  const ai = await alice.req(`/hub/api/teams/${A}/reports/ai-share.csv?${RANGE}`);
  assert.equal(ai.status, 200);
  assert.match(ai.headers.get('content-type'), /^text\/csv/);
  assert.equal(ai.headers.get('content-disposition'), 'attachment; filename="grapim-ai-share-2026-10-26-to-2026-11-08.csv"');
  const lines = ai.text.trimEnd().split('\r\n');
  assert.equal(lines[0], 'week_start,commits,commits_with_totals,ai_lines,human_lines,added_lines,ai_share,ai_lines_claude-code,ai_lines_codex,ai_lines_cursor');
  assert.equal(lines[2], `2026-11-02,4,2,59,64,110,${Math.round((46 / 110) * 10000) / 10000},41,10,8`);

  const un = (await alice.req(`/hub/api/teams/${A}/reports/unreviewed.csv?${RANGE}`)).text;
  assert.match(un, /^repo,run,label,kind,status,lines,files,commits,first_commit,last_commit,intent\r\n/);
  assert.match(un, /"'=HYPERLINK\(""http:\/\/x""\)"/, 'a label that is a formula is defused');
  assert.doesNotMatch(un, /,=HYPERLINK/);

  const ag = (await alice.req(`/hub/api/teams/${A}/reports/agents.csv?${RANGE}`)).text.split('\r\n');
  assert.equal(ag[1], 'claude-code,claude,2,2,1,1,0,1,0.5,0.5,3,45,41');
  const act = (await alice.req(`/hub/api/teams/${A}/reports/activity.csv?${RANGE}`)).text.split('\r\n');
  assert.equal(act.length, 16, 'header, 14 days, final line end');
  assert.ok(act.includes('2026-11-03,2,2,3,0,1'));
});

// ---------------------------------------------------------------- gating

test('gating: free and team get 402 with last week\'s AI share only; governance gets the reports', async (t) => {
  const { h, alice, A } = await setup(t);
  const db = h.hub.db;
  for (const plan of ['free', 'team']) {
    db.prepare('UPDATE teams SET plan = ? WHERE id = ?').run(plan, A);
    for (const name of REPORTS) {
      for (const suffix of ['', '.csv']) {
        const r = await alice.req(`/hub/api/teams/${A}/reports/${name}${suffix}?${RANGE}`);
        assert.equal(r.status, 402, `${plan} ${name}${suffix}`);
        const body = r.json();
        assert.equal(body.error.code, 'plan_required');
        // Last full week before Wed 11 Nov: 2 to 8 Nov, and nothing else.
        assert.deepEqual(Object.keys(body.teaser).sort(), ['added', 'ai', 'ai_in_share', 'caveats', 'commits', 'commits_with_totals', 'human', 'repos_not_recorded', 'repos_total', 'repos_with_provenance', 'share', 'week', 'week_end']);
        assert.deepEqual([body.teaser.week, body.teaser.week_end, body.teaser.ai, body.teaser.added, body.teaser.share], ['2026-11-02', '2026-11-08', 59, 110, 46 / 110]);
        assert.equal(body.weeks, undefined);
        assert.equal(body.agents, undefined);
      }
    }
    const page = await alice.req(`/hub/teams/${A}/reports/agents`);
    assert.equal(page.status, 200);
    assert.match(page.text, /42%<\/span> of added lines were written by AI agents/);
    assert.match(page.text, /Governance/);
    assert.match(page.text, /\$40/);
    // The shell's Ctrl K palette lists the team's runs; the report itself must not.
    assert.doesNotMatch(page.text.replace(/<template id="palette-src">[\s\S]*?<\/template>/, ''), /Export CSV|class="kpis"|codex 7/, `${plan}: no report beyond the teaser`);
  }
  db.prepare("UPDATE teams SET plan = 'governance' WHERE id = ?").run(A);
  assert.equal((await alice.req(`/hub/api/teams/${A}/reports/agents?${RANGE}`)).status, 200);
  const page = (await alice.req(`/hub/teams/${A}/reports/agents?${RANGE}`)).text;
  assert.match(page, /Export CSV/);
  assert.match(page, /class="kpis"/);
  // A governance team whose payment lapsed past the grace period is back to the teaser.
  db.prepare("UPDATE teams SET plan_status = 'canceled' WHERE id = ?").run(A);
  assert.equal((await alice.req(`/hub/api/teams/${A}/reports/agents?${RANGE}`)).status, 200, 'without a billing module the stored plan stands');
});

test('every report page renders, with charts, tables and empty states that say what to run', async (t) => {
  const { h, alice, A } = await setup(t);
  for (const name of REPORTS) {
    const r = await alice.req(`/hub/teams/${A}/reports/${name}?${RANGE}`);
    assert.equal(r.status, 200, name);
    assert.match(r.text, /<table class="table/, `${name} has a data table`);
    assert.match(r.text, /<svg/, `${name} has a chart`);
    assert.doesNotMatch(r.text, /<script>|style="/, `${name}: no inline script or style (CSP)`);
    assert.match(r.text, /aria-current="page"[^>]*>Reports|>Reports<\/a>/);
  }
  assert.equal((await alice.req(`/hub/teams/${A}/reports`)).status, 200);
  // Empty: a team with nothing synced.
  const B = await createTeam(alice, 'Empty Co');
  h.hub.db.prepare("UPDATE teams SET plan = 'governance' WHERE id = ?").run(B);
  const ai = (await alice.req(`/hub/teams/${B}/reports/ai-share`)).text;
  assert.match(ai, /No provenance in this range/);
  assert.match(ai, /grapim init/);
  assert.match(ai, /grapim sync/);
  const act = (await alice.req(`/hub/teams/${B}/reports/activity`)).text;
  assert.match(act, /No synced runs in this range/);
  assert.match(act, /grapim sync --watch/);
});

// ---------------------------------------------------------------- isolation

test('tenant isolation: another team gets 404 on every report route, and cannot filter by a foreign repo', async (t) => {
  const { h, alice, A } = await setup(t);
  const mallory = await signIn(h, 'mallory');
  const M = await createTeam(mallory, 'Mallory Co');
  h.hub.db.prepare("UPDATE teams SET plan = 'governance' WHERE id = ?").run(M);
  const routes = h.hub.router.routes.filter((r) => r.pattern.includes('/reports'));
  // Each report's page, JSON and CSV, the Reports tab, and the audit evidence page, print view and CSV.
  assert.equal(routes.length, REPORTS.length * 3 + 1 + 3);
  for (const r of routes) {
    assert.equal(r.opts.team, true, `${r.pattern} is a team route (so the enumerated isolation test covers it)`);
    assert.equal(r.opts.auth, 'session');
    const p = r.pattern.replace(':team', A);
    const res = await mallory.req(`${p}?${RANGE}`);
    assert.equal(res.status, 404, `mallory ${p}`);
    assert.doesNotMatch(res.text, /alpha|Alpha Co|claude aaa|codex 7/);
    assert.equal((await new Browser(h.base).req(p)).status, p.includes('/api/') ? 401 : 303, `signed out ${p}`);
  }
  // Her own team, with alpha's repo id: 404, and her reports are empty.
  assert.equal((await mallory.req(`/hub/api/teams/${M}/reports/ai-share?repo=${R1}`)).status, 404);
  const mine = (await mallory.req(`/hub/api/teams/${M}/reports/ai-share?${RANGE}`)).json();
  assert.equal(mine.totals.commits, 0);
  assert.equal(mine.coverage.repos_total, 0);
  // A machine token is not a way in either.
  const tok = await mallory.post(`/hub/teams/${M}/tokens`, { name: 'box' });
  const token = tok.text.match(/value="(cmh_[A-Za-z0-9_-]+)"/)[1];
  const viaToken = await fetch(`${h.base}/hub/api/teams/${A}/reports/ai-share`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(viaToken.status, 401);
});

// ---------------------------------------------------------------- cache

test('cache: one computation per team and query within the hour; a sync invalidates it', async (t) => {
  const { h, alice, A } = await setup(t);
  const reports = h.hub.reports;
  const url = `/hub/api/teams/${A}/reports/activity?${RANGE}`;
  const first = (await alice.req(url)).json();
  const n = reports.computed;
  assert.deepEqual((await alice.req(url)).json(), first, 'same answer');
  assert.equal(reports.computed, n, 'served from the cache');
  await alice.req(`/hub/api/teams/${A}/reports/activity.csv?${RANGE}`);
  assert.equal(reports.computed, n, 'the CSV uses the same cached report');

  // A machine syncs one more run on 5 Nov.
  const tok = await alice.post(`/hub/teams/${A}/tokens`, { name: 'laptop' });
  const token = tok.text.match(/value="(cmh_[A-Za-z0-9_-]+)"/)[1];
  const ts = at('2026-11-05T10:00:00Z');
  const res = await fetch(`${h.base}/hub/api/sync`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      repo: { id: R1, name: 'alpha' },
      machine: 'laptop',
      cursor: { changes: 0, events: 0, agents: 0 },
      runs: [{ run: 'claude-code:new', turn: 1, started_at: ts }],
      agents: [{ agent: 'claude-code:new', label: 'claude newnewne', intent: 'x', worktree: 'wt', last_seen: ts }],
      changes: [{ id: 1, run: 'claude-code:new', label: 'claude newnewne', turn: 1, worktree: 'wt', path: 'n.js', before_sha: null, after_sha: null, untracked: false, added: 1, removed: 0, ts }],
      events: [],
      blobs: {},
    }),
  });
  assert.equal(res.status, 200, await res.text());
  const after = (await alice.req(url)).json();
  assert.equal(reports.computed, n + 1, 'recomputed after the sync');
  assert.equal(after.totals.runs, first.totals.runs + 1);
  assert.equal(after.days.find((d) => d.date === '2026-11-05').runs, 1);

  // A note received (by any path) changes the key too.
  rows(h.hub.db, A).note(R1, sha1('late'), { v: 1, runs: [], files: {}, commit: { ts: at('2026-11-06T10:00:00Z'), added: 7 } }, NOW);
  const share = (await alice.req(`/hub/api/teams/${A}/reports/ai-share?${RANGE}`)).json();
  assert.equal(share.totals.added, 167);

  // And an hour later the entry is recomputed regardless.
  const m = reports.computed;
  h.clock.t += 61 * 60 * 1000;
  await alice.req(url);
  assert.equal(reports.computed, m + 1);
  // Other teams never share an entry.
  assert.ok([...reports.cache.keys()].every((k) => k.startsWith(`${A}|`)));
});

// ---------------------------------------------------------------- the governance plan

test('governance plan: price, limits, features, plan helpers', () => {
  assert.deepEqual(PLANS.governance.price.perSeat, { month: 40, year: 384 });
  assert.deepEqual(PLANS.governance.price.env, { month: 'STRIPE_PRICE_GOVERNANCE_MONTH', year: 'STRIPE_PRICE_GOVERNANCE_YEAR' });
  assert.deepEqual(PLANS.team.price.perSeat, { month: 20, year: 192 }, 'Team unchanged');
  assert.deepEqual(CHECKOUT_PLANS, ['team', 'governance']);
  assert.deepEqual(limitsFor('governance'), { seats: Infinity, historyDays: 365, repos: Infinity });
  assert.deepEqual(limitsFor('governance', { seats: 9 }), { seats: 9, historyDays: 365, repos: Infinity });
  assert.deepEqual(limitsFor('governance').features, { reports: true, requireReview: true });
  assert.deepEqual(limitsFor('team').features, { reports: false, requireReview: false });
  assert.deepEqual(limitsFor('free').features, { reports: false, requireReview: false });
  assert.deepEqual(limitsFor('enterprise').features, { reports: true, requireReview: true });
  assert.deepEqual(limitsFor('gold').features, { reports: false, requireReview: false });
  assert.deepEqual(featuresFor('governance'), { reports: true, requireReview: true });
  limitsFor('governance').features.reports = false;
  assert.equal(limitsFor('governance').features.reports, true, 'callers get a copy');

  // makeLimits carries features, with or without the billing module, and
  // follows effectivePlan (a lapsed governance team is free).
  const billing = { ...createBilling({ env: {} }), limitsFor, effectivePlan: (team) => (team.plan_status === 'canceled' ? 'free' : team.plan) };
  const limits = makeLimits(billing);
  assert.deepEqual(limits({ plan: 'governance', seats: 5 }).features, { reports: true, requireReview: true });
  assert.equal(limits({ plan: 'governance', seats: 5 }).seats, 5);
  assert.deepEqual(limits({ plan: 'governance', plan_status: 'canceled' }).features, { reports: false, requireReview: false });
  assert.deepEqual(makeLimits(null)({ plan: 'governance' }).features, { reports: true, requireReview: true });
  assert.equal(makeLimits(null)({ plan: 'governance' }).historyDays, 365);
  assert.deepEqual(makeLimits(null)({ plan: 'team' }).features, { reports: false, requireReview: false });
});

const ENV = {
  STRIPE_SECRET_KEY: 'sk_test_51abcdefSECRET',
  STRIPE_PRICE_TEAM_MONTH: 'price_team_month',
  STRIPE_PRICE_TEAM_YEAR: 'price_team_year',
  STRIPE_PRICE_GOVERNANCE_MONTH: 'price_gov_month',
  STRIPE_PRICE_GOVERNANCE_YEAR: 'price_gov_year',
  STRIPE_WEBHOOK_SECRET: 'whsec_test_secret',
};

test('governance checkout: the governance price, and the plan in both metadata', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(Object.fromEntries(new URLSearchParams(init.body)));
    return new Response(JSON.stringify({ url: 'https://checkout.stripe.com/c/pay/cs_test_g' }), { status: 200 });
  };
  const billing = createBilling({ env: ENV, fetch });
  const args = { team: { id: 'team_g' }, user: { id: 'u' }, seats: 6, successUrl: 'https://a', cancelUrl: 'https://b' };
  await billing.createCheckout({ ...args, interval: 'year', plan: 'governance' });
  assert.equal(calls[0]['line_items[0][price]'], 'price_gov_year');
  assert.equal(calls[0]['line_items[0][quantity]'], '6');
  assert.equal(calls[0]['metadata[plan]'], 'governance');
  assert.equal(calls[0]['subscription_data[metadata][plan]'], 'governance');
  await billing.createCheckout({ ...args, interval: 'month' });
  assert.equal(calls[1]['line_items[0][price]'], 'price_team_month', 'Team is still the default');
  assert.equal(calls[1]['metadata[plan]'], undefined);
  await assert.rejects(billing.createCheckout({ ...args, interval: 'month', plan: 'enterprise' }), (e) => e.code === 'bad_request');
  await assert.rejects(billing.createCheckout({ ...args, interval: 'month', plan: 'free' }), (e) => e.code === 'bad_request');
  const unset = createBilling({ env: { ...ENV, STRIPE_PRICE_GOVERNANCE_MONTH: '' }, fetch });
  await assert.rejects(unset.createCheckout({ ...args, interval: 'month', plan: 'governance' }), (e) => e.code === 'not_configured');
});

test('governance webhooks: checkout and subscription events set governance; a portal switch follows the price', async () => {
  const sign = (body, t) => `t=${t},v1=${crypto.createHmac('sha256', ENV.STRIPE_WEBHOOK_SECRET).update(`${t}.${body}`).digest('hex')}`;
  const deliver = async (type, object) => {
    const t = Math.floor(NOW / 1000);
    const body = JSON.stringify({ id: `evt_${type}`, type, created: t, data: { object } });
    const calls = [];
    await createBilling({ env: ENV, fetch: () => assert.fail('no Stripe call') }).handleWebhook(Buffer.from(body), sign(body, t), { setPlan: async (id, u) => calls.push(u), now: NOW });
    return calls[0];
  };
  const done = await deliver('checkout.session.completed', { mode: 'subscription', payment_status: 'paid', client_reference_id: 'team_g', metadata: { team_id: 'team_g', seats: '6', plan: 'governance' }, customer: 'cus_g', subscription: 'sub_g' });
  assert.equal(done.plan, 'governance');
  const sub = (over) => ({ id: 'sub_g', status: 'active', customer: 'cus_g', metadata: { team_id: 'team_g', plan: 'governance' }, items: { data: [{ quantity: 6, price: { id: 'price_gov_month' } }] }, ...over });
  assert.equal((await deliver('customer.subscription.updated', sub())).plan, 'governance');
  // Switched to Team in the Billing Portal: the metadata still says governance, the price says team.
  assert.equal((await deliver('customer.subscription.updated', sub({ items: { data: [{ quantity: 6, price: { id: 'price_team_month' } }] } }))).plan, 'team');
  // And back, with no metadata at all.
  assert.equal((await deliver('customer.subscription.updated', sub({ metadata: { team_id: 'team_g' }, items: { data: [{ quantity: 6, price: 'price_gov_year' }] } }))).plan, 'governance');
  // Hand-made enterprise subscriptions keep their plan whatever the price.
  assert.equal((await deliver('customer.subscription.updated', sub({ metadata: { team_id: 'team_g', plan: 'enterprise' } }))).plan, 'enterprise');
});

test('settings and checkout route: an owner can choose Governance', async (t) => {
  const gh = fakeGitHub();
  const calls = [];
  const billing = {
    limitsFor,
    createCheckout: async (args) => {
      calls.push(args);
      return { url: 'https://checkout.stripe.com/c/pay/cs_test_g' };
    },
    createPortal: async () => ({ url: 'https://billing.stripe.com/p/session/x' }),
    handleWebhook: async () => ({ handled: false }),
  };
  const hub = await createHub({
    env: { HUB_URL: ORIGIN, HUB_SECRET: 'test-secret-that-is-long-enough-0123456789', HUB_DATA: tmp('grapim-reports-'), GITHUB_CLIENT_ID: 'gh-client', GITHUB_CLIENT_SECRET: 'gh-secret', STRIPE_PRICE_TEAM_MONTH: 'p1', STRIPE_PRICE_GOVERNANCE_MONTH: 'p2', STRIPE_PRICE_GOVERNANCE_YEAR: 'p3' },
    fetch: gh.fetch,
    log: () => {},
    billing,
    now: () => NOW,
  });
  const addr = await hub.listen(0, '127.0.0.1');
  t.after(() => hub.close());
  const h = { hub, gh, base: `http://127.0.0.1:${addr.port}` };
  const owner = await signIn(h, 'buyer');
  const team = await createTeam(owner, 'Buyers');
  const settings = (await owner.req(`/hub/teams/${team}/settings/plan`)).text;
  assert.match(settings, /<option value="governance"/);
  assert.match(settings, /<option value="year">Yearly/);
  const teaser = (await owner.req(`/hub/teams/${team}/reports`)).text;
  assert.match(teaser, /name="plan" value="governance"/);
  assert.match(teaser, /Upgrade to Governance/);
  assert.equal((await owner.post('/hub/billing/checkout', { team, seats: '2', interval: 'month', plan: 'governance' })).status, 303);
  assert.equal(calls[0].plan, 'governance');
  assert.equal((await owner.post('/hub/billing/checkout', { team, seats: '2', interval: 'month', plan: 'bogus' })).status, 303);
  assert.equal(calls[1].plan, 'team', 'anything else is Team');
  const billingJson = (await owner.req(`/hub/api/teams/${team}/billing`)).json();
  assert.deepEqual(billingJson.features, { reports: false, requireReview: false });
});
