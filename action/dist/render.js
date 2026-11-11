// The PR provenance summary (docs/provenance.md section 4): one Markdown
// comment shared by the GitHub Action, the GitHub App and
// `grapim provenance pr`. Pure: no I/O, no imports, so the Action can bundle
// it as is (action/bundle.mjs) and it runs on Node 20.
//
// renderSummary({ files, notesByCommit, blameByFile, reviews, omittedFiles, limit })
//   files:         [{ path, added: [[start, end], ...] | [line, ...] }]
//                  or [{ path, skipped: 'reason' }] for a file that was not attributed.
//                  Line numbers are 1-based, in the file at the PR head.
//   blameByFile:   { [path]: [{ start, end, commit, orig, path? }] } (or a Map):
//                  head lines start..end came from `commit`, where `orig` is the
//                  line number of `start` in that commit's version of the file
//                  (consecutive), and `path` its name there if it was renamed.
//                  orig null: the line could not be located in that commit.
//   notesByCommit: { [sha]: note object or its JSON } (or a Map): refs/notes/grapim.
//   reviews:       { [runId]: 'pending'|'approved'|'rejected' | { status, text? } } (or a Map):
//                  the review status in Grapim, newer than the note's snapshot;
//                  `text`, when given, is shown instead of the plain status.
//   omittedFiles:  files the caller did not attribute (over its file cap).
//   limit:         the comment's size budget in characters (GitHub's is 65,536).
// -> { markdown, stats }
//
// Everything that comes from a note (run ids, labels, intents) or a PR (paths)
// is untrusted: an agent wrote the intent, anyone can name a file. md() makes
// it inert text: no table breaks, no @mentions, no links, no HTML.

export const MARKER = '<!-- grapim:provenance -->';
export const EMPTY_MARKER = '<!-- grapim:provenance:empty -->';
export const GITHUB_LIMIT = 65_536;
export const DEFAULT_LIMIT = 64_000; // a margin under GitHub's limit
const REVIEWS = ['pending', 'approved', 'rejected'];
const KINDS = ['claude-code', 'codex', 'cursor', 'mcp', 'http', 'sync', 'undo', 'restore'];

// ---- Escaping ----

const ZWSP = '\u200b';
// C0/C1 controls, zero-width and joiner characters, line/paragraph separators,
// bidi embeddings, overrides and isolates, the BOM: never shown, never kept.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g;
// Every ASCII character Markdown or HTML gives a meaning to. As a numeric
// character reference it is always literal text (CommonMark 6.2), and a table
// only splits cells on a raw "|".
const SPECIAL = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g;

// Untrusted text -> one line of inert GitHub Markdown, at most `max` characters
// before escaping.
export function md(value, max = 200) {
  let s = String(value ?? '').replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(s);
  if (chars.length > max) s = `${chars.slice(0, Math.max(1, max - 1)).join('').trimEnd()}…`;
  // GitHub links @user, @org/team, #123, owner/repo#123, emails, http(s)://,
  // www. and mailto: in rendered text, after references are decoded: a zero
  // width space right after the trigger character breaks every one of them.
  s = s.replace(/[@#:]/g, (c) => c + ZWSP).replace(/www\./gi, (m) => `${m.slice(0, 3)}${ZWSP}.`);
  return s.replace(SPECIAL, (c) => `&#${c.charCodeAt(0)};`);
}

const plural = (n, one, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const num = (n) => n.toLocaleString('en-US');

// ---- Inputs ----

const asMap = (v) => (v instanceof Map ? v : new Map(Object.entries(v ?? {})));
const isLine = (n) => Number.isSafeInteger(n) && n >= 1;

// [[s, e], ...] or [line, ...] -> sorted, merged [[s, e], ...]
export function toRanges(added) {
  const out = [];
  for (const a of Array.isArray(added) ? added : []) {
    const [s, e] = Array.isArray(a) ? a : [a, a];
    if (isLine(s) && isLine(e) && e >= s) out.push([s, e]);
  }
  out.sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  return merged;
}

export function kindOf(run) {
  if (KINDS.includes(run?.kind)) return run.kind;
  const id = String(run?.id ?? '');
  if (id.startsWith('claude-code:')) return 'claude-code';
  if (id.startsWith('mcp:')) return /codex/i.test(id) ? 'codex' : /cursor/i.test(id) ? 'cursor' : 'mcp';
  if (id.startsWith('http:')) return 'http';
  if (id.startsWith('sync-')) return 'sync';
  return 'agent';
}

// A note as stored in refs/notes/grapim, validated. Anything malformed is
// dropped (the lines it would explain count as human or unknown).
export function parseNote(raw) {
  let n = raw;
  if (typeof raw === 'string' || raw instanceof Uint8Array) {
    try {
      n = JSON.parse(String(raw));
    } catch {
      return null;
    }
  }
  if (!n || typeof n !== 'object' || n.v !== 1 || !Array.isArray(n.runs) || !n.files || typeof n.files !== 'object') return null;
  const runs = n.runs.map((r) =>
    r && typeof r === 'object' && typeof r.id === 'string' && r.id
      ? {
          id: r.id.slice(0, 300),
          label: typeof r.label === 'string' ? r.label.slice(0, 300) : null,
          kind: kindOf(r),
          review: REVIEWS.includes(r.review) ? r.review : null,
          turns: new Map((Array.isArray(r.turns) ? r.turns : []).filter((t) => t && Number.isSafeInteger(t.turn)).map((t) => [t.turn, typeof t.intent === 'string' ? t.intent.slice(0, 1000) : null])),
        }
      : null,
  );
  const files = new Map();
  for (const [p, list] of Object.entries(n.files)) {
    if (!Array.isArray(list)) continue;
    const ok = list.filter((x) => Array.isArray(x) && isLine(x[0]) && isLine(x[1]) && x[1] >= x[0] && Number.isSafeInteger(x[2]) && runs[x[2]]).sort((a, b) => a[0] - b[0]);
    if (ok.length) files.set(p, ok);
  }
  return { runs, files };
}

// The [start, end, runIndex, turn] entry holding `line`, by binary search.
function entryAt(list, line) {
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const e = list[mid];
    if (line < e[0]) hi = mid - 1;
    else if (line > e[1]) lo = mid + 1;
    else return e;
  }
  return null;
}

const reviewOf = (v) => (REVIEWS.includes(v) ? v : REVIEWS.includes(v?.status) ? v.status : null);

// ---- Attribution ----

export function attribute({ files = [], notesByCommit, blameByFile, reviews } = {}) {
  const notesRaw = asMap(notesByCommit);
  const blames = asMap(blameByFile);
  const reviewMap = asMap(reviews);
  const notes = new Map();
  const noteOf = (sha) => {
    if (!notes.has(sha)) notes.set(sha, notesRaw.has(sha) ? parseNote(notesRaw.get(sha)) : null);
    return notes.get(sha);
  };

  const runs = new Map(); // run id -> aggregate
  const perFile = [];
  let added = 0;
  let ai = 0;
  const seen = new Set();
  for (const f of Array.isArray(files) ? files : []) {
    if (!f || typeof f.path !== 'string' || seen.has(f.path)) continue;
    seen.add(f.path);
    if (f.skipped) {
      perFile.push({ path: f.path, added: null, ai: 0, byRun: new Map(), skipped: String(f.skipped) });
      continue;
    }
    const ranges = toRanges(f.added);
    const blame = (blames.get(f.path) ?? []).filter((b) => b && isLine(b.start) && isLine(b.end) && b.end >= b.start && typeof b.commit === 'string').sort((a, b) => a.start - b.start);
    const row = { path: f.path, added: 0, ai: 0, byRun: new Map() };
    let bi = 0;
    for (const [s, e] of ranges) {
      for (let line = s; line <= e; line++) {
        row.added++;
        while (bi < blame.length && blame[bi].end < line) bi++;
        const b = blame[bi];
        if (!b || b.start > line) continue;
        const note = noteOf(b.commit);
        if (!note) continue;
        if (!Number.isSafeInteger(b.orig)) continue;
        const list = note.files.get(typeof b.path === 'string' ? b.path : f.path);
        const hit = list && entryAt(list, b.orig + (line - b.start));
        if (!hit) continue;
        const run = note.runs[hit[2]];
        let agg = runs.get(run.id);
        if (!agg) {
          agg = { id: run.id, label: run.label, kind: run.kind, lines: 0, files: new Set(), turns: new Map(), noteReviews: [] };
          runs.set(run.id, agg);
        }
        if (!agg.label && run.label) agg.label = run.label;
        if (run.review) agg.noteReviews.push(run.review);
        agg.lines++;
        agg.files.add(f.path);
        const turn = Number.isSafeInteger(hit[3]) ? hit[3] : null;
        const t = agg.turns.get(turn) ?? { turn, intent: null, lines: 0 };
        t.lines++;
        if (!t.intent && turn !== null && run.turns.get(turn)) t.intent = run.turns.get(turn);
        agg.turns.set(turn, t);
        row.ai++;
        row.byRun.set(run.id, (row.byRun.get(run.id) ?? 0) + 1);
      }
    }
    added += row.added;
    ai += row.ai;
    perFile.push(row);
  }

  const runList = [...runs.values()]
    .map((r) => {
      // Grapim's own status wins; else the notes' snapshot at commit time: any
      // rejection, else approved only if every note says so.
      const given = reviewMap.has(r.id) ? reviewMap.get(r.id) : null;
      const fromHub = given === null ? null : reviewOf(given);
      // { status, text }: the caller's words for the Review column (the App: "Approved locally by …, not in the hub").
      const reviewText = typeof given?.text === 'string' && given.text ? given.text.slice(0, 200) : null;
      const review = fromHub ?? (r.noteReviews.includes('rejected') ? 'rejected' : r.noteReviews.length && r.noteReviews.every((x) => x === 'approved') ? 'approved' : 'pending');
      const turns = [...r.turns.values()].sort((a, b) => b.lines - a.lines || (a.turn ?? 0) - (b.turn ?? 0));
      return { id: r.id, label: r.label || r.id, kind: r.kind, lines: r.lines, files: r.files.size, review, reviewText, prompts: turns.filter((t) => t.intent).length, intent: turns.find((t) => t.intent)?.intent ?? null, turns: turns.map((t) => ({ turn: t.turn, lines: t.lines, intent: t.intent })) };
    })
    .sort((a, b) => b.lines - a.lines || a.label.localeCompare(b.label));
  return { added, ai, runs: runList, files: perFile, notes: [...notes.values()].filter(Boolean).length };
}

// ---- Rendering ----

const REVIEW_TEXT = { approved: 'Approved', pending: 'Not reviewed', rejected: 'Rejected' };

function share(ai, added) {
  if (!added || !ai) return '0%';
  const p = Math.round((ai / added) * 100);
  if (p === 0) return '<1%';
  if (p === 100 && ai < added) return '99%';
  return `${p}%`;
}

function headline(a) {
  if (!a.added) return '**No added lines to attribute in this pull request.**';
  if (!a.ai) return `**None of the ${plural(a.added, 'added line')} came from an AI agent run Grapim recorded.**`;
  const top = a.runs.slice(0, 5).map((r) => `${md(r.label, 60)} ${num(r.lines)}`);
  const rest = a.runs.slice(5);
  if (rest.length) top.push(`${plural(rest.length, 'more run')} ${num(rest.reduce((n, r) => n + r.lines, 0))}`);
  return `**${share(a.ai, a.added)} of the added lines were written by AI agents** (${num(a.ai)} of ${num(a.added)}): ${top.join(', ')}`;
}

const runRow = (r) => {
  const prompt = r.intent ? `${md(r.intent, 140)}${r.prompts > 1 ? ` <sub>+${r.prompts - 1} more</sub>` : ''}` : '<sub>not recorded</sub>';
  return `| ${md(r.label, 60)} | ${md(r.kind, 20)} | ${num(r.lines)} | ${num(r.files)} | ${prompt} | ${r.reviewText ? md(r.reviewText, 80) : REVIEW_TEXT[r.review]} |`;
};

const fileRow = (f, labels) => {
  if (f.skipped) return `| <code>${md(f.path, 160)}</code> | | | <sub>not attributed: ${md(f.skipped, 60)}</sub> |`;
  const by = [...f.byRun.entries()].sort((x, y) => y[1] - x[1]);
  const who = by.slice(0, 4).map(([id, n]) => `${md(labels.get(id) ?? id, 40)} ${num(n)}`);
  if (by.length > 4) who.push(`${by.length - 4} more`);
  return `| <code>${md(f.path, 160)}</code> | ${num(f.added)} | ${num(f.ai)} | ${who.join(', ')} |`;
};

// Adds rows to `out` while they fit in `budget`; returns how many were left out.
function fill(out, rows, budget) {
  let used = out.reduce((n, s) => n + s.length + 1, 0);
  let i = 0;
  for (; i < rows.length; i++) {
    if (used + rows[i].length + 1 > budget) break;
    out.push(rows[i]);
    used += rows[i].length + 1;
  }
  return rows.length - i;
}

export function renderSummary({ files = [], notesByCommit = {}, blameByFile = {}, reviews = {}, omittedFiles = 0, limit = DEFAULT_LIMIT } = {}) {
  const a = attribute({ files, notesByCommit, blameByFile, reviews });
  // Infinity (the CLI): no budget. Else room is kept for the truncation notes and the footer.
  const budget = limit === Infinity ? Infinity : Math.max(2_000, Math.min(Number(limit) || DEFAULT_LIMIT, GITHUB_LIMIT)) - 400;
  const labels = new Map(a.runs.map((r) => [r.id, r.label]));
  const unapproved = a.runs.filter((r) => r.review !== 'approved');
  const skipped = a.files.filter((f) => f.skipped).length;
  const omitted = Math.max(0, Number(omittedFiles) || 0);

  const head = [MARKER, '### Grapim provenance', '', headline(a)];
  if (omitted) head.push('', `<sub>Only the first ${plural(a.files.length, 'file')} of this pull request were attributed; ${plural(omitted, 'more file was', 'more files were')} not.</sub>`);
  const build = (budget) => {
  const parts = [head.join('\n')];
  const used = () => parts.reduce((n, s) => n + s.length + 2, 0);
  const cut = { runs: 0, unreviewed: 0, files: 0 };

  if (a.runs.length) {
    const out = ['| Run | Agent | Lines | Files | Prompt | Review |', '| --- | --- | ---: | ---: | --- | --- |'];
    cut.runs = fill(out, a.runs.map(runRow), budget - used());
    if (cut.runs) out.push(`| <sub>${plural(cut.runs, 'more run')} not shown</sub> | | | | | |`);
    parts.push(out.join('\n'));

    if (unapproved.length) {
      const list = ['#### Not reviewed in Grapim', ''];
      const rows = unapproved.map((r) => `- ${md(r.label, 60)}: ${plural(r.lines, 'line')} in ${plural(r.files, 'file')}${r.reviewText ? ` (${md(r.reviewText, 80)})` : r.review === 'rejected' ? ' (rejected)' : ''}`);
      cut.unreviewed = fill(list, rows, budget - used());
      if (cut.unreviewed) list.push(`- <sub>${plural(cut.unreviewed, 'more run')} not shown</sub>`);
      parts.push(list.join('\n'));
    } else {
      parts.push('Every AI-written line here comes from a run approved in Grapim.');
    }
  }

  if (a.files.length) {
    const open = `<details><summary>Per-file breakdown (${plural(a.files.length, 'file')}${skipped ? `, ${skipped} not attributed` : ''})</summary>`;
    const out = [open, '', '| File | Added | By AI | Runs |', '| --- | ---: | ---: | --- |'];
    const rows = [...a.files].sort((x, y) => (y.ai - x.ai) || ((y.added ?? -1) - (x.added ?? -1)) || x.path.localeCompare(y.path)).map((f) => fileRow(f, labels));
    cut.files = fill(out, rows, budget - used() - 20);
    if (cut.files) out.push(`| <sub>${plural(cut.files, 'more file')} not shown</sub> | | | |`);
    out.push('', '</details>');
    parts.push(out.join('\n'));
  }

  const truncated = cut.runs + cut.unreviewed + cut.files > 0;
  if (truncated) parts.push('<sub>Shortened to fit GitHub’s comment size. Run <code>grapim provenance pr &lt;base&gt;..&lt;head&gt;</code> locally for everything.</sub>');
  parts.push('<sub>Lines are matched to agent runs through git notes in <code>refs/notes/grapim</code>, written by Grapim at commit time.</sub>');
  return { markdown: parts.join('\n\n') + '\n', truncated };
  };

  // The truncation notes and the footer sit outside the budget: shrink it
  // until the whole comment fits.
  const cap = limit === Infinity ? Infinity : Math.min(Number(limit) || DEFAULT_LIMIT, GITHUB_LIMIT);
  let { markdown, truncated } = build(budget);
  for (let b = budget, k = 0; markdown.length > cap && k < 8; k++) {
    b -= markdown.length - cap + 200;
    ({ markdown, truncated } = build(b));
  }
  // A last guard: never over the limit, and never cut inside the details.
  if (markdown.length > cap) markdown = `${head.join('\n')}\n\n<sub>The full breakdown is too large for a comment.</sub>\n`;

  const stats = {
    files: a.files.length,
    skippedFiles: skipped,
    omittedFiles: omitted,
    added: a.added,
    ai: a.ai,
    share: a.added ? a.ai / a.added : 0,
    notes: a.notes,
    runs: a.runs.map(({ id, label, kind, lines, files: n, review, intent }) => ({ id, label, kind, lines, files: n, review, intent })),
    unapproved: unapproved.map((r) => ({ id: r.id, label: r.label, review: r.review, lines: r.lines })),
    truncated,
  };
  return { markdown, stats };
}

// The comment for a repo where provenance is not set up: posted once, and
// replaced by the real summary when notes show up.
export function renderEmpty({ via = 'action' } = {}) {
  const steps =
    via === 'app'
      ? ['1. In the repo, run <code>grapim init</code>. It installs the git hooks that write a note per commit and push <code>refs/notes/grapim</code>.', '2. Run <code>grapim sync</code> to your team hub, so the notes reach Grapim.', '3. Commit and push as usual.']
      : ['1. In the repo, run <code>grapim init</code>. It installs the git hooks that write a note per commit and push <code>refs/notes/grapim</code>.', '2. Commit and push as usual. The next run of this check picks the notes up.'];
  return [
    MARKER,
    EMPTY_MARKER,
    '### Grapim provenance',
    '',
    '**No AI provenance was found for this pull request.**',
    '',
    'Grapim records which agent run wrote each line, from which prompt, and whether someone reviewed it. To turn it on:',
    '',
    ...steps,
    '',
    '<sub>This note is posted once. It turns into the summary when there is something to show.</sub>',
    '',
  ].join('\n');
}
