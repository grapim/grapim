// The provenance note format (docs/provenance.md section 1): one git note per
// commit under refs/notes/grapim, compact JSON, at most 256 KB.
//
//   { v: 1, tool, runs: [{ id, label, kind, turns: [{ turn, intent? }], review }],
//     files: { path: [[startLine, endLine, runIndex, turn], ...] } }
//
// No I/O here: the CLI, the hub ingest, the Action and the App all use it.
// A note body may hold several notes, one JSON document per line, when git
// concatenated them (notes.rewriteMode=concatenate after a squash, or a
// `git notes merge -s union`): parseNote merges them into one.

export const NOTE_REF = 'refs/notes/grapim';
export const NOTES_REF_NAME = 'grapim'; // for `git notes --ref=grapim`
export const NOTE_VERSION = 1;
export const MAX_NOTE_BYTES = 256 * 1024;
export const INTENT_MAX = 140;
export const KINDS = Object.freeze(['claude-code', 'codex', 'cursor', 'mcp', 'http', 'sync', 'undo', 'restore']);
export const REVIEWS = Object.freeze(['pending', 'approved', 'rejected']);

const MAX_RUNS = 1000;
const MAX_TURNS = 10000;
const MAX_FILES = 20000;
const MAX_LINE = 100_000_000;

export class NoteError extends Error {}
const bad = (msg) => {
  throw new NoteError(msg);
};

// The agent kind from a run id. Run ids: claude-code:<session>, <mcp client
// name>:<pid> (codex-mcp-client:123, cursor-vscode:123, mcp:123), http:<name>
// (workspace agents), sync-<machine> or http:sync-<machine> (folder sync),
// undo:<ts>, restore:<ts>.
export function kindOf(runId) {
  const id = String(runId ?? '').toLowerCase();
  if (id.startsWith('claude-code:')) return 'claude-code';
  if (id.startsWith('undo:')) return 'undo';
  if (id.startsWith('restore:')) return 'restore';
  // Folder sync writes as agent sync-<machine>: through a workspace's HTTP API
  // that is http:sync-<machine>.
  if (id.startsWith('sync-') || id.startsWith('http:sync-')) return 'sync';
  if (id.startsWith('http:')) return 'http';
  const client = id.split(':')[0];
  if (client.includes('codex')) return 'codex';
  if (client.includes('cursor')) return 'cursor';
  return 'mcp';
}

// A human acting through the CLI (`--agent human:<user>`) is not an agent run.
export const isAgentRun = (runId) => typeof runId === 'string' && runId.length > 0 && !runId.startsWith('human:');

// The first non-empty line, at most 140 characters.
export function clipIntent(s, n = INTENT_MAX) {
  const line = String(s ?? '').trim().split(/\r?\n/).find((l) => l.trim()) ?? '';
  const chars = [...line.trim()];
  return chars.length > n ? chars.slice(0, n - 1).join('') + '…' : chars.join('');
}

// Collapses one [line, runIndex, turn] per attributed line (1-based, sorted
// or not) into [start, end, runIndex, turn] ranges.
export function toRanges(lines) {
  const sorted = [...lines].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [line, run, turn] of sorted) {
    const last = out.at(-1);
    if (last && last[1] === line - 1 && last[2] === run && last[3] === turn) last[1] = line;
    else if (!(last && last[1] >= line)) out.push([line, line, run, turn]);
  }
  return out;
}

// Builds a note from attributed lines. lines: [{ path, line, run, turn }];
// info(run) -> { label, review, intent(turn) } for each run id. With no lines
// it is the empty note (runs: [], files: {}): the commit was recorded and no
// agent wrote any of it. With intents: false the turns carry no intent.
export function buildNote(lines, info, { intents = true, tool = 'grapim/0.1.0', commit = null } = {}) {
  const runIds = [...new Set(lines.map((l) => l.run))].sort();
  const index = new Map(runIds.map((r, i) => [r, i]));
  const runs = runIds.map((id) => {
    const meta = info(id) ?? {};
    const turns = [...new Set(lines.filter((l) => l.run === id).map((l) => l.turn))].sort((a, b) => a - b);
    return {
      id,
      label: String(meta.label || id).slice(0, 200),
      kind: kindOf(id),
      turns: turns.map((turn) => {
        const intent = intents && meta.intent ? clipIntent(meta.intent(turn)) : '';
        return intent ? { turn, intent } : { turn };
      }),
      review: REVIEWS.includes(meta.review) ? meta.review : 'pending',
    };
  });
  const byFile = new Map();
  for (const l of lines) {
    if (!byFile.has(l.path)) byFile.set(l.path, []);
    byFile.get(l.path).push([l.line, index.get(l.run), l.turn]);
  }
  const files = {};
  for (const p of [...byFile.keys()].sort()) files[p] = toRanges(byFile.get(p));
  const block = commitBlock(commit);
  return { v: NOTE_VERSION, tool, runs, files, ...(block ? { commit: block } : {}) };
}

const bytes = (s) => new TextEncoder().encode(s).length;

// Compact JSON within MAX_NOTE_BYTES. Past the cap the intents are dropped;
// if that is still too big, whole files are dropped (largest first) and the
// note says truncated: true.
export function serializeNote(note, max = MAX_NOTE_BYTES) {
  let json = JSON.stringify(note);
  if (bytes(json) <= max) return json;
  const slim = { ...note, runs: note.runs.map((r) => ({ ...r, turns: r.turns.map((t) => ({ turn: t.turn })) })) };
  json = JSON.stringify(slim);
  if (bytes(json) <= max) return json;
  const files = { ...slim.files };
  const order = Object.keys(files).sort((a, b) => files[b].length - files[a].length || (a < b ? -1 : 1));
  const out = { ...slim, files, truncated: true };
  for (const p of order) {
    delete files[p];
    json = JSON.stringify(out);
    if (bytes(json) <= max) return json;
  }
  return JSON.stringify({ ...out, files: {} });
}

const isInt = (v, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= min && v <= max;
const isText = (v, max) => typeof v === 'string' && v.length <= max && !v.includes('\u0000');

// The optional commit block (section 1, for reports): { ts, added, default_branch },
// each key optional. Keys that are not valid are dropped, never fatal.
export function commitBlock(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  const out = {};
  if (isInt(c.ts, 0, 8.64e15)) out.ts = c.ts;
  if (isInt(c.added, 0, MAX_LINE)) out.added = c.added;
  if (typeof c.default_branch === 'boolean') out.default_branch = c.default_branch;
  return Object.keys(out).length ? out : null;
}

// Checks one parsed note and returns a normalised copy. Throws NoteError.
export function validateNote(n) {
  if (!n || typeof n !== 'object' || Array.isArray(n)) bad('The note is not a JSON object.');
  if (n.v !== NOTE_VERSION) bad(`Unknown note version ${JSON.stringify(n.v)}.`);
  if (n.tool !== undefined && !isText(n.tool, 100)) bad('tool must be a short string.');
  if (!Array.isArray(n.runs) || n.runs.length > MAX_RUNS) bad(`runs must be an array of at most ${MAX_RUNS}.`);
  const runs = n.runs.map((r, i) => {
    if (!r || typeof r !== 'object') bad(`runs[${i}] is not an object.`);
    if (!isText(r.id, 200) || !r.id) bad(`runs[${i}].id must be a string of at most 200 characters.`);
    if (r.label !== undefined && !isText(r.label, 200)) bad(`runs[${i}].label is too long.`);
    if (!KINDS.includes(r.kind)) bad(`runs[${i}].kind must be one of ${KINDS.join(', ')}.`);
    if (!REVIEWS.includes(r.review ?? 'pending')) bad(`runs[${i}].review must be one of ${REVIEWS.join(', ')}.`);
    if (!Array.isArray(r.turns) || r.turns.length > MAX_TURNS) bad(`runs[${i}].turns must be an array.`);
    const turns = r.turns.map((t, j) => {
      if (!t || !isInt(t.turn)) bad(`runs[${i}].turns[${j}].turn must be an integer.`);
      if (t.intent !== undefined && !isText(t.intent, INTENT_MAX * 2)) bad(`runs[${i}].turns[${j}].intent is too long.`);
      return t.intent ? { turn: t.turn, intent: t.intent } : { turn: t.turn };
    });
    return { id: r.id, label: r.label ?? r.id, kind: r.kind, turns, review: r.review ?? 'pending' };
  });
  if (!n.files || typeof n.files !== 'object' || Array.isArray(n.files)) bad('files must be an object.');
  const paths = Object.keys(n.files);
  if (paths.length > MAX_FILES) bad(`At most ${MAX_FILES} files.`);
  const files = {};
  for (const p of paths) {
    if (!p || !isText(p, 1024)) bad('A file path is empty or too long.');
    const ranges = n.files[p];
    if (!Array.isArray(ranges)) bad(`files[${JSON.stringify(p.slice(0, 80))}] must be an array.`);
    files[p] = ranges.map((x) => {
      if (!Array.isArray(x) || x.length !== 4) bad('A range must be [startLine, endLine, runIndex, turn].');
      const [s, e, r, t] = x;
      if (!isInt(s, 1, MAX_LINE) || !isInt(e, s, MAX_LINE) || !isInt(r, 0, runs.length - 1) || !isInt(t)) bad(`Invalid range ${JSON.stringify(x).slice(0, 80)}.`);
      return [s, e, r, t];
    });
  }
  const block = commitBlock(n.commit);
  return { v: NOTE_VERSION, tool: n.tool ?? 'unknown', runs, files, ...(n.truncated ? { truncated: true } : {}), ...(block ? { commit: block } : {}) };
}

// [start, end, runIndex, turn] entries in priority order (the first to claim a
// line wins) -> sorted, disjoint ranges, adjacent ones of the same run and
// turn joined. Works on range boundaries, never per line: a range may claim up
// to MAX_LINE lines, and a loop over lines let a 250-byte note hold the
// process for seconds and gigabytes (docs/security-review-github-reports-2026-11-11.md, H1).
export function resolveRanges(entries) {
  if (!entries.length) return [];
  const xs = [...new Set(entries.flatMap(([s, e]) => [s, e + 1]))].sort((a, b) => a - b);
  const at = new Map(xs.map((x, i) => [x, i]));
  const owner = new Array(xs.length - 1).fill(null);
  // next[i]: the first segment at or after i that no entry claimed yet.
  const next = Int32Array.from({ length: xs.length }, (_, i) => i);
  const find = (i) => {
    while (next[i] !== i) {
      next[i] = next[next[i]];
      i = next[i];
    }
    return i;
  };
  for (const en of entries) {
    const b = at.get(en[1] + 1);
    for (let i = find(at.get(en[0])); i < b; i = find(i)) {
      owner[i] = en;
      next[i] = i + 1;
    }
  }
  const out = [];
  owner.forEach((en, i) => {
    if (!en) return;
    const s = xs[i];
    const e = xs[i + 1] - 1;
    const last = out.at(-1);
    if (last && last[1] === s - 1 && last[2] === en[2] && last[3] === en[3]) last[1] = e;
    else out.push([s, e, en[2], en[3]]);
  });
  return out;
}

// Merges notes for the same commit (concatenated by git): runs are united by
// id, ranges kept, overlapping ranges resolved in favour of the first note
// (and, inside one note, of the first range).
export function mergeNotes(notes) {
  if (notes.length === 1) {
    const n = notes[0];
    const files = {};
    for (const [p, ranges] of Object.entries(n.files)) files[p] = resolveRanges(ranges);
    return { ...n, files };
  }
  const runs = [];
  const index = new Map();
  const lines = new Map(); // path -> [[start, end, runIndex, turn], ...] in priority order
  for (const n of notes) {
    const remap = n.runs.map((r) => {
      if (!index.has(r.id)) {
        index.set(r.id, runs.length);
        runs.push({ ...r, turns: [...r.turns] });
      } else {
        const have = runs[index.get(r.id)];
        for (const t of r.turns) if (!have.turns.some((x) => x.turn === t.turn)) have.turns.push(t);
        have.turns.sort((a, b) => a.turn - b.turn);
      }
      return index.get(r.id);
    });
    for (const [p, ranges] of Object.entries(n.files)) {
      if (!lines.has(p)) lines.set(p, []);
      const list = lines.get(p);
      for (const [s, e, r, t] of ranges) list.push([s, e, remap[r], t]);
    }
  }
  const files = {};
  for (const p of [...lines.keys()].sort()) files[p] = resolveRanges(lines.get(p));
  const block = notes.find((n) => n.commit)?.commit;
  return { v: NOTE_VERSION, tool: notes[0].tool, runs, files, ...(notes.some((n) => n.truncated) ? { truncated: true } : {}), ...(block ? { commit: block } : {}) };
}

// Parses a note body: one JSON note, or several (one per line) merged.
// Throws NoteError when the body is over the cap or not a valid note.
export function parseNote(text, { max = MAX_NOTE_BYTES } = {}) {
  if (typeof text !== 'string') bad('The note must be text.');
  if (bytes(text) > max) bad(`The note is over ${max} bytes.`);
  const docs = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!docs.length) bad('The note is empty.');
  const notes = docs.map((d) => {
    let obj;
    try {
      obj = JSON.parse(d);
    } catch {
      bad('The note is not valid JSON.');
    }
    return validateNote(obj);
  });
  return mergeNotes(notes);
}

// Who wrote a line of a file as committed in the note's commit, or null.
export function lookupLine(note, path, line) {
  for (const [s, e, r, t] of note?.files?.[path] ?? []) {
    if (line >= s && line <= e) {
      const run = note.runs[r];
      return { run: run.id, label: run.label, kind: run.kind, turn: t, intent: run.turns.find((x) => x.turn === t)?.intent ?? null, review: run.review };
    }
  }
  return null;
}

// Attributed line count per file and per run index.
export function noteCounts(note) {
  const files = {};
  const runs = note.runs.map(() => 0);
  for (const [p, ranges] of Object.entries(note.files)) {
    files[p] = 0;
    for (const [s, e, r] of ranges) {
      files[p] += e - s + 1;
      runs[r] += e - s + 1;
    }
  }
  return { files, runs, total: runs.reduce((a, b) => a + b, 0) };
}
