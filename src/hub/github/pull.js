// A pull request event, processed off the request path (docs/provenance.md
// sections 4 and 6):
//
//   list the PR files (paginated) -> sizes of the head blobs (GraphQL) ->
//   GraphQL blame per changed file at the head (at most 50 files, each at most
//   3 MB) -> the commits of the added lines -> the team's notes for them
//   (provenanceFor, through the owner/name -> hub repo mapping) -> render ->
//   upsert the marker comment -> create or update the "Grapim provenance" check run.
//
// GraphQL blame gives head line numbers only, while a note's line numbers are
// those of the file as committed in its commit. For a commit other than the
// head, the head lines are mapped back into that commit's version with a line
// diff (src/diff.js), fetched only for (file, commit) pairs whose note lists
// that file.

import { ignoreEol, matchLines, splitLines } from '../../diff.js';
import { MARKER, md, parseNote, renderEmpty, renderSummary } from '../../provenance/render.js';
import { GitHubClient } from './client.js';

export const MAX_BLAME_FILES = 50;
export const MAX_BLOB_BYTES = 3 * 1024 * 1024;
export const MAX_LIST_FILES = 3000;
// Unique, so a branch rule can require exactly this check from the Grapim App
// (security review M6). The Action posts a comment only, never a check.
export const CHECK_NAME = 'Grapim provenance (app)';
// GitHub lists at most 250 commits of a pull request.
export const MAX_PR_COMMITS = 250;
// Runs whose lines are people's work, not an agent's (docs/provenance.md section 7).
const PEOPLE_KINDS = new Set(['sync', 'undo', 'restore']);
const LIST_MAX = 50; // rows per list in the check summary
// The line mapping diffs file versions in the hub's one process: bounded per
// job (bytes fetched, pairs, lines per side), and it yields between pairs, so
// one account's pull requests cannot stall the hub for every team.
const MAX_TEXT_BYTES = 8 * 1024 * 1024; // per job
const MAX_MAPPED_PAIRS = 100;
const MAX_MAP_LINES = 50_000; // per side; a longer file's lines stay unlocated (orig null)
export const MAX_NOTE_BYTES_PER_JOB = 32 * 1024 * 1024; // of stored notes read for one pull request
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;

// Added line ranges at the head, from a unified diff patch (the PR files API).
export function parsePatch(patch) {
  const lines = [];
  let n = null;
  for (const line of String(patch ?? '').split('\n')) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) {
      n = Number(h[1]);
      continue;
    }
    if (n === null) continue;
    if (line.startsWith('+')) lines.push(n++);
    else if (line.startsWith(' ')) n++;
  }
  const ranges = [];
  for (const l of lines) {
    const last = ranges[ranges.length - 1];
    if (last && l === last[1] + 1) last[1] = l;
    else ranges.push([l, l]);
  }
  return ranges;
}

const BLAME = `query($owner:String!,$name:String!,$oid:GitObjectID!,$path:String!){repository(owner:$owner,name:$name){object(oid:$oid){... on Commit{blame(path:$path){ranges{startingLine endingLine commit{oid}}}}}}}`;

async function blobs(gh, owner, name, exprs, fields, per) {
  const out = new Map();
  for (let i = 0; i < exprs.length; i += per) {
    const chunk = exprs.slice(i, i + per);
    const vars = { owner, name };
    const defs = ['$owner:String!', '$name:String!'];
    const sel = [];
    chunk.forEach((e, j) => {
      vars[`e${j}`] = e;
      defs.push(`$e${j}:String!`);
      sel.push(`f${j}:object(expression:$e${j}){... on Blob{${fields}}}`);
    });
    const { data } = await gh.graphql(`query(${defs.join(',')}){repository(owner:$owner,name:$name){${sel.join(' ')}}}`, vars);
    chunk.forEach((e, j) => out.set(e, data?.repository?.[`f${j}`] ?? null));
  }
  return out;
}

async function blame(gh, owner, name, oid, path) {
  const { data } = await gh.graphql(BLAME, { owner, name, oid, path });
  const ranges = data?.repository?.object?.blame?.ranges;
  if (!Array.isArray(ranges)) return [];
  return ranges
    .filter((r) => Number.isSafeInteger(r?.startingLine) && Number.isSafeInteger(r?.endingLine) && r.endingLine >= r.startingLine && SHA.test(String(r?.commit?.oid)))
    .map((r) => ({ start: r.startingLine, end: r.endingLine, commit: r.commit.oid }));
}

const overlaps = (r, ranges) => ranges.some(([s, e]) => r.start <= e && r.end >= s);

// Splits a blame range into runs of head lines whose positions in the
// commit's version are consecutive. from[i]: index in that version of head line i+1, or -1.
function remap(range, from) {
  const out = [];
  let cur = null;
  for (let line = range.start; line <= range.end; line++) {
    const o = from[line - 1];
    const orig = Number.isInteger(o) && o >= 0 ? o + 1 : null;
    if (cur && orig !== null && cur.orig !== null && cur.orig + (line - cur.start) === orig) cur.end = line;
    else if (cur && orig === null && cur.orig === null) cur.end = line;
    else {
      cur = { start: line, end: line, commit: range.commit, orig };
      out.push(cur);
    }
  }
  return out;
}

async function upsertComment(gh, repoPath, number, markdown, { botLogin, once }) {
  const comments = await gh.paginate(`${repoPath}/issues/${number}/comments`, 3000);
  // Only a comment this App wrote: anyone can paste the marker into theirs.
  const ours = comments.find((c) => typeof c?.body === 'string' && c.body.startsWith(MARKER) && c.user?.type === 'Bot' && c.user?.login === botLogin);
  if (ours && (once || ours.body === markdown)) return { action: 'unchanged', id: ours.id };
  if (ours) {
    await gh.rest('PATCH', `${repoPath}/issues/comments/${ours.id}`, { body: markdown });
    return { action: 'updated', id: ours.id };
  }
  const c = await gh.rest('POST', `${repoPath}/issues/${number}/comments`, { body: markdown });
  return { action: 'created', id: c?.id ?? null };
}

async function upsertCheck(gh, repoPath, headSha, { conclusion, title, summary, slug, now }) {
  const list = await gh.rest('GET', `${repoPath}/commits/${headSha}/check-runs?check_name=${encodeURIComponent(CHECK_NAME)}&per_page=100`);
  // Only a check run this App made: another App or a workflow can create one
  // with the same name, and GitHub refuses to let us update it anyway.
  const mine = (Array.isArray(list?.check_runs) ? list.check_runs : []).find((c) => c?.name === CHECK_NAME && c.app?.slug === slug);
  const body = { name: CHECK_NAME, status: 'completed', conclusion, completed_at: new Date(now).toISOString(), output: { title: title.slice(0, 250), summary: summary.slice(0, 60_000) } };
  if (mine) {
    await gh.rest('PATCH', `${repoPath}/check-runs/${mine.id}`, body);
    return { action: 'updated', id: mine.id, conclusion };
  }
  const c = await gh.rest('POST', `${repoPath}/check-runs`, { ...body, head_sha: headSha });
  return { action: 'created', id: c?.id ?? null, conclusion };
}

// A URL path segment that stays one token inside a Markdown link.
const seg = (s) => encodeURIComponent(String(s)).replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const who = (r) => md(r?.reviewer_login || r?.login || (r?.machine ? `the machine ${r.machine}` : 'a member'), 60);

// What the comment shows in the Review column: the hub's decision, else a
// note that a machine's own approval does not count.
function displayReview(hubReview, local) {
  if (hubReview && !hubReview.stale) return hubReview.status === 'approved' ? 'approved' : { status: 'rejected', text: `Rejected in the hub by ${hubReview.reviewer_login || 'a member'}` };
  if (hubReview?.stale) return { status: 'pending', text: `Changed since ${hubReview.status} in the hub by ${hubReview.reviewer_login || 'a member'}` };
  if (local?.status === 'approved' || local?.status === 'rejected') return { status: 'pending', text: `${local.status === 'approved' ? 'Approved' : 'Rejected'} locally by ${local.login || local.machine || 'a machine'}, not in the hub` };
  return 'pending';
}

// The require_review decision (docs/provenance.md section 6) and its summary.
// Fails closed: anything the App could not check fails the check, with the reason.
export function decide({ requireProvenance, runs, hubReviews, localReviews, places, unrecorded, incomplete, peopleLines, link }) {
  const unapproved = [];
  for (const r of runs) {
    const h = hubReviews.get(r.id);
    if (h && h.status === 'approved' && !h.stale) continue;
    const l = localReviews.get(r.id);
    const why = h?.stale
      ? `Approved in the hub by ${who(h)}, but the run changed after that: review it again.`
      : h?.status === 'rejected'
        ? `Rejected in the hub by ${who(h)}.`
        : 'Not reviewed in the hub.';
    const localText = l && (l.status === 'approved' || l.status === 'rejected') ? ` ${l.status === 'approved' ? 'Approved' : 'Rejected'} locally by ${who(l)} (informational, does not count).` : '';
    const place = places.get(r.id);
    const where = place ? `[Review in the hub](${link(place, r.id)})` : 'Never synced to the hub: run `grapim sync` on the machine that ran it, then review it there.';
    unapproved.push({ ...r, line: `- **${md(r.label, 60)}**: ${r.estimate ? 'up to ' : ''}${plural(r.lines, 'line')}. ${why}${localText} ${where}` });
  }
  const missing = requireProvenance ? unrecorded : [];
  const failing = unapproved.length > 0 || missing.length > 0 || incomplete.length > 0;

  const titles = [];
  if (unapproved.length) titles.push(`${plural(unapproved.length, 'agent run')} not approved in the Grapim hub`);
  if (missing.length) titles.push(`${plural(missing.length, 'commit')} not recorded`);
  if (incomplete.length) titles.push('not every added line could be checked');
  const title = failing ? titles.join('; ') : 'Every AI-written line is approved in the Grapim hub';

  const out = [
    `**Policy: require review.** Every line an AI agent wrote must come from a run approved in the Grapim hub by a member other than the person who synced it.${requireProvenance ? ' Require provenance is on: every commit that adds lines needs a Grapim note (an empty note from a human-only commit counts).' : ''} Approvals made with \`grapim review\` on a machine are shown but do not count.`,
  ];
  if (unapproved.length) {
    out.push(`#### Runs to approve in the hub (${unapproved.length})`, [...unapproved.slice(0, LIST_MAX).map((u) => u.line), ...(unapproved.length > LIST_MAX ? [`- and ${plural(unapproved.length - LIST_MAX, 'more run')}`] : [])].join('\n'));
  }
  if (missing.length) {
    out.push(
      `#### Not recorded: ${plural(missing.length, 'commit')} without a Grapim note`,
      'These commits add lines to this pull request but have no provenance note, so nobody can tell whether an agent wrote them. On the machine that made them, run `grapim init`, then `grapim provenance record <commit>` and `grapim sync`. If these are human-only commits from a machine without Grapim, an owner can turn off Require provenance in the hub (Settings, GitHub).',
      [...missing.slice(0, LIST_MAX).map((c) => `- \`${c.slice(0, 12)}\``), ...(missing.length > LIST_MAX ? [`- and ${plural(missing.length - LIST_MAX, 'more commit')}`] : [])].join('\n'),
    );
  } else if (unrecorded.length) {
    out.push(`${plural(unrecorded.length, 'commit')} in this pull request ${unrecorded.length === 1 ? 'has' : 'have'} no Grapim note. Require provenance is off, so ${unrecorded.length === 1 ? 'it is' : 'they are'} accepted as human.`);
  }
  if (incomplete.length) out.push('#### Could not be checked', incomplete.map((s) => `- ${s}`).join('\n'));
  if (peopleLines) out.push(`${plural(peopleLines, 'line')} from undo, restore or folder-sync runs count as people's work and need no approval.`);
  if (!failing) out.push(`Passed: every AI-written line comes from a run approved in the hub${requireProvenance ? ', and every commit that adds lines has a provenance note' : ''}.`);
  return { conclusion: failing ? 'failure' : 'success', title, summary: out.join('\n\n'), unapproved, unrecorded: missing };
}

// job: { installationId, owner, name, number, headSha, repoId? (GitHub repository id) }
// ctx: { db, teams, auth, apiBase, fetch, now, sleep, signal, slug, source, origin,
//        requireReview(team), requireProvenance(team), track({ team, job, runs, hubRepo }) }
export async function processPullRequest(ctx, job) {
  const { db, teams, auth, source } = ctx;
  if (!NAME.test(job.owner) || !NAME.test(job.name) || !Number.isSafeInteger(job.number) || !SHA.test(job.headSha)) return { skipped: 'bad_event' };
  const inst = db.prepare('SELECT * FROM gh_installations WHERE id = ?').get(job.installationId);
  if (!inst?.team_id || inst.deleted_at || inst.suspended_at) return { skipped: 'unlinked' };
  const team = teams.get(inst.team_id);
  if (!team) return { skipped: 'unlinked' };

  const token = await auth.installationToken(inst.id);
  const gh = new GitHubClient({ apiBase: ctx.apiBase, token, fetch: ctx.fetch, now: ctx.now, sleep: ctx.sleep, signal: ctx.signal, ...(ctx.maxWaitMs ? { maxWaitMs: ctx.maxWaitMs } : {}) });
  const repoPath = `/repos/${job.owner}/${job.name}`;
  const fullName = `${job.owner}/${job.name}`;
  const botLogin = `${ctx.slug}[bot]`;
  const head = job.headSha;
  const requireReview = ctx.requireReview(team);
  const requireProvenance = requireReview && !!ctx.requireProvenance?.(team);

  const hubRepo = await source.repoFor(team, fullName);
  const finishEmpty = async () => {
    const comment = await upsertComment(gh, repoPath, job.number, renderEmpty({ via: 'app' }), { botLogin, once: true });
    const check = await upsertCheck(gh, repoPath, head, {
      conclusion: 'neutral',
      title: 'No AI provenance yet',
      summary: 'Grapim has no provenance notes for this repository yet. Run `grapim init` in the repo and `grapim sync` to your team hub.',
      slug: ctx.slug,
      now: ctx.now(),
    });
    return { empty: true, comment, check };
  };
  // Without the policy, a repo Grapim knows nothing about gets the short
  // "how to enable" comment and a neutral check. Under require_review it is
  // checked like any other: its commits have no notes (fail closed).
  if (!hubRepo && !requireReview) return finishEmpty();

  // 1. Files, largest additions first; the first 50 are blamed.
  const listed = await gh.paginate(`${repoPath}/pulls/${job.number}/files`, MAX_LIST_FILES);
  const changed = listed
    .filter((f) => f && typeof f.filename === 'string' && f.filename.length <= 1000 && f.status !== 'removed' && Number(f.additions) > 0)
    .sort((a, b) => b.additions - a.additions || a.filename.localeCompare(b.filename));
  const chosen = changed.slice(0, MAX_BLAME_FILES);
  const omittedFiles = changed.length - chosen.length;
  const info = await blobs(gh, job.owner, job.name, chosen.map((f) => `${head}:${f.filename}`), 'byteSize isBinary', 25);

  const files = [];
  const blameByFile = {};
  const commits = new Set();
  for (const f of chosen) {
    const meta = info.get(`${head}:${f.filename}`);
    if (meta?.isBinary) continue;
    if (Number(meta?.byteSize) > MAX_BLOB_BYTES) {
      files.push({ path: f.filename, skipped: 'over 3 MB' });
      continue;
    }
    const added = parsePatch(f.patch);
    if (!f.patch || !added.length) {
      files.push({ path: f.filename, skipped: 'diff too large to read' });
      continue;
    }
    const ranges = (await blame(gh, job.owner, job.name, head, f.filename)).filter((r) => overlaps(r, added));
    files.push({ path: f.filename, added });
    blameByFile[f.filename] = ranges;
    for (const r of ranges) commits.add(r.commit);
  }

  // 2. Notes for those commits, and whether this repo has provenance at all.
  const notes = hubRepo ? await source.notesFor(team, hubRepo, [...commits], { maxBytes: MAX_NOTE_BYTES_PER_JOB }) : new Map();
  const noProvenance = !notes.size && !(hubRepo && (await source.hasAny(team, hubRepo)));
  if (noProvenance && !requireReview) return finishEmpty();
  const parsed = new Map([...notes].map(([sha, n]) => [sha, parseNote(n)]));

  // 3. Line numbers inside each noted commit's version of the file.
  const pairs = [];
  for (const [p, ranges] of Object.entries(blameByFile)) {
    for (const c of new Set(ranges.map((r) => r.commit))) {
      if (c !== head && parsed.get(c)?.files.has(p)) pairs.push([p, c]);
    }
  }
  const mapped = pairs.slice(0, MAX_MAPPED_PAIRS);
  const exprs = [...new Set(mapped.flatMap(([p, c]) => [`${head}:${p}`, `${c}:${p}`]))];
  const texts = new Map();
  let budget = MAX_TEXT_BYTES;
  for (let i = 0; i < exprs.length && budget > 0; i += 4) {
    const got = await blobs(gh, job.owner, job.name, exprs.slice(i, i + 4), 'byteSize isBinary text', 4);
    for (const [e, b] of got) {
      if (typeof b?.text === 'string' && !b.isBinary && Number(b.byteSize) <= MAX_BLOB_BYTES) {
        texts.set(e, b.text);
        budget -= b.text.length;
      }
    }
  }
  const lineMaps = new Map(); // `${commit}:${path}` -> from[]
  for (const [p, c] of mapped) {
    const a = texts.get(`${c}:${p}`);
    const b = texts.get(`${head}:${p}`);
    if (a === undefined || b === undefined) continue;
    const la = splitLines(Buffer.from(a));
    const lb = splitLines(Buffer.from(b));
    if (la.length > MAX_MAP_LINES || lb.length > MAX_MAP_LINES) continue;
    if (ctx.signal?.aborted) throw new Error('Stopped.');
    lineMaps.set(`${c}:${p}`, matchLines(la, lb, ignoreEol));
    await new Promise((r) => setImmediate(r)); // let other requests in between two diffs
  }
  for (const [p, ranges] of Object.entries(blameByFile)) {
    blameByFile[p] = ranges.flatMap((r) => {
      if (r.commit === head) return [{ ...r, orig: r.start }];
      const from = lineMaps.get(`${r.commit}:${p}`);
      return from ? remap(r, from) : [{ ...r, orig: null }];
    });
  }

  // 4. Under require_review, what line-by-line attribution could not see is
  // checked conservatively from the notes, and every gap is named.
  const incomplete = [];
  const unrecorded = new Set();
  const extra = new Map(); // run id -> { id, label, kind, lines (upper bound), estimate: true }
  if (requireReview) {
    // Commits of added lines: a stored note, an unreadable one, or none at all.
    const noted = hubRepo ? ((await source.notedFor?.(team, hubRepo, [...commits])) ?? new Set(notes.keys())) : new Set();
    let unreadable = 0;
    for (const c of commits) {
      if (!noted.has(c)) unrecorded.add(c);
      else if (!parsed.get(c)) unreadable++;
    }
    if (unreadable) incomplete.push(`${plural(unreadable, 'provenance note')} could not be read (over the App's ${MAX_NOTE_BYTES_PER_JOB / 1024 / 1024} MB of notes per pull request, or malformed).`);

    // Runs a note lists for a file whose lines could not be matched one by one:
    // all of their lines count, as if every one were still in the pull request.
    const claim = (note, p) => {
      for (const [s, e, i] of note.files.get(p) ?? []) {
        const run = note.runs[i];
        if (!run) continue;
        const x = extra.get(run.id) ?? { id: run.id, label: run.label || run.id, kind: run.kind, lines: 0, estimate: true };
        x.lines += e - s + 1;
        extra.set(run.id, x);
      }
    };
    for (const [p, ranges] of Object.entries(blameByFile)) {
      const done = new Set();
      for (const r of ranges) {
        const note = parsed.get(r.commit);
        if (r.orig !== null || !note?.files.has(p) || done.has(r.commit)) continue;
        done.add(r.commit);
        claim(note, p);
      }
    }

    // Files never blamed (past the file cap, over 3 MB, no readable diff):
    // read the notes of every commit of the pull request instead.
    const unchecked = [...files.filter((f) => f.skipped).map((f) => f.path), ...changed.slice(MAX_BLAME_FILES).map((f) => f.filename)];
    if (unchecked.length) {
      const list = await gh.paginate(`${repoPath}/pulls/${job.number}/commits`, MAX_PR_COMMITS);
      if (list.length >= MAX_PR_COMMITS) incomplete.push(`This pull request has ${MAX_PR_COMMITS} or more commits, more than GitHub lists, and ${plural(unchecked.length, 'file')} could not be attributed line by line. Split it.`);
      const own = list.filter((c) => SHA.test(String(c?.sha)) && !(Array.isArray(c?.parents) && c.parents.length > 1)).map((c) => c.sha);
      const prNotes = hubRepo ? await source.notesFor(team, hubRepo, own, { maxBytes: MAX_NOTE_BYTES_PER_JOB }) : new Map();
      const prNoted = hubRepo ? ((await source.notedFor?.(team, hubRepo, own)) ?? new Set(prNotes.keys())) : new Set();
      let unread = 0;
      for (const c of own) {
        if (!prNoted.has(c)) {
          unrecorded.add(c); // it may have added lines to an unchecked file
          continue;
        }
        const note = parseNote(prNotes.get(c));
        if (!note) {
          unread++;
          continue;
        }
        for (const p of unchecked) claim(note, p);
      }
      if (unread) incomplete.push(`${plural(unread, 'provenance note')} of this pull request's commits could not be read.`);
    }
  }

  // 5. Review statuses: the hub's decisions count; a machine's own are shown only.
  const runIds = [...new Set([...[...parsed.values()].flatMap((n) => (n ? n.runs.filter(Boolean).map((r) => r.id) : [])), ...extra.keys()])];
  const hubReviews = hubRepo ? await source.hubReviewsFor(team, hubRepo, runIds) : new Map();
  const localReviews = hubRepo ? await source.localReviewsFor(team, hubRepo, runIds) : new Map();
  const reviews = new Map(runIds.map((id) => [id, displayReview(hubReviews.get(id), localReviews.get(id))]));
  const { markdown, stats } = renderSummary({ files, notesByCommit: notes, blameByFile, reviews, omittedFiles });
  const comment = noProvenance
    ? await upsertComment(gh, repoPath, job.number, renderEmpty({ via: 'app' }), { botLogin, once: true })
    : await upsertComment(gh, repoPath, job.number, markdown, { botLogin, once: false });

  // The AI runs of this pull request (line by line, plus the conservative ones).
  const aiRuns = new Map();
  let peopleLines = 0;
  for (const r of stats.runs) {
    if (PEOPLE_KINDS.has(r.kind)) peopleLines += r.lines;
    else aiRuns.set(r.id, { id: r.id, label: r.label, kind: r.kind, lines: r.lines });
  }
  for (const x of extra.values()) {
    if (PEOPLE_KINDS.has(x.kind)) continue;
    const r = aiRuns.get(x.id);
    if (r) {
      r.lines += x.lines;
      r.estimate = true;
    } else aiRuns.set(x.id, { ...x });
  }
  await ctx.track?.({ team, job, hubRepo, runs: [...aiRuns.keys()] });

  let decision = null;
  if (requireReview) {
    const places = hubRepo ? await source.placesFor(team, hubRepo, [...aiRuns.keys()]) : new Map();
    const origin = String(ctx.origin ?? '').replace(/\/+$/, '');
    decision = decide({
      requireProvenance,
      runs: [...aiRuns.values()].sort((a, b) => b.lines - a.lines || String(a.label).localeCompare(String(b.label))),
      hubReviews,
      localReviews,
      places,
      unrecorded: [...unrecorded].sort(),
      incomplete,
      peopleLines,
      link: (place, run) => `${origin}/hub/teams/${seg(team.id)}/repos/${seg(place.repo_id)}/runs/${seg(run)}?machine=${seg(place.machine)}`,
    });
  }
  const pct = stats.added ? Math.round(stats.share * 100) : 0;
  const title = decision
    ? decision.title
    : stats.ai
      ? `${pct || '<1'}% of added lines written by AI agents`
      : 'No AI-written lines found';
  const body = markdown.replace(`${MARKER}\n`, '');
  const check = await upsertCheck(gh, repoPath, head, {
    conclusion: decision ? decision.conclusion : 'neutral',
    title,
    summary: decision ? `${decision.summary}\n\n---\n\n${body}` : body,
    slug: ctx.slug,
    now: ctx.now(),
  });
  return { empty: noProvenance, stats, decision, comment, check, calls: gh.calls };
}
