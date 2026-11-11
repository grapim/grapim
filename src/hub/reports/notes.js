// Reading provenance notes (docs/provenance.md section 1) for reports.
//
// Notes are synced input: anything here may be malformed or hostile. A note
// that does not parse is skipped and counted; numbers are clamped; ranges are
// merged per file so overlapping ranges are never counted twice.

// Agent kinds whose lines count as AI-written. sync, undo and restore runs are
// a person syncing a folder or taking work back: their lines are not AI (in a
// recorded commit they are human lines).
export const SYSTEM_KINDS = new Set(['sync', 'undo', 'restore']);
export const isAiKind = (kind) => !SYSTEM_KINDS.has(kind);

const MAX_RUNS = 1000; // runs read from one note
const MAX_RANGES = 50_000; // ranges read from one note
const MAX_SPAN = 1_000_000; // lines one range may claim
const MAX_LINE = 10_000_000;

// The agent kind of a run, from its id (section 1, Kind; the same rules as
// kindOf in src/provenance/note.js). Run ids: claude-code:<session>, <mcp
// client>:<pid> (codex-mcp-client:1, cursor-vscode:1, mcp:1), http:<name>,
// sync-<machine> (folder sync; http:sync-<machine> through the workspace),
// undo:<ts>, restore:<ts>. A note's declared kind is not trusted over the id.
export function kindOf(id) {
  const run = String(id ?? '').toLowerCase();
  if (run.startsWith('claude-code:')) return 'claude-code';
  if (run.startsWith('undo:')) return 'undo';
  if (run.startsWith('restore:')) return 'restore';
  if (run.startsWith('sync-') || run.startsWith('http:sync-')) return 'sync';
  if (run.startsWith('http:')) return 'http';
  const client = run.split(':')[0];
  if (client.includes('codex')) return 'codex';
  if (client.includes('cursor')) return 'cursor';
  return 'mcp';
}

// "claude 1a2b3c4d" -> "claude"; "sandbox-12" -> "sandbox"; "ci-bot-7f3a" -> "ci-bot".
export function labelPrefix(label, id = '') {
  const first = String(label || id || '').trim().split(/\s+/)[0] || 'unknown';
  const base = first.replace(/:.*$/, '').replace(/(?:[-_.](?:\d+|[0-9a-f]{4,})|\d+)$/i, '');
  return (base || first).slice(0, 60);
}

const int = (v, max) => (Number.isSafeInteger(v) && v >= 0 && v <= max ? v : null);
// Like int, but a fractional number (a time in ms from a float) is floored.
const whole = (v, max) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? Math.floor(v) : null);

// { ts, added, defaultBranch, runs: [{ id, kind, label, prefix, review, intent, lines }],
//   ai, recorded, files } or null when the body is not a note.
export function parseNote(json) {
  let n;
  try {
    n = typeof json === 'string' ? JSON.parse(json) : json;
  } catch {
    return null;
  }
  if (!n || typeof n !== 'object' || Array.isArray(n)) return null;
  if (n.runs !== undefined && !Array.isArray(n.runs)) return null;
  if (n.files !== undefined && (typeof n.files !== 'object' || n.files === null || Array.isArray(n.files))) return null;

  const runs = (n.runs ?? []).slice(0, MAX_RUNS).map((r) => {
    const o = r && typeof r === 'object' ? r : {};
    const id = typeof o.id === 'string' ? o.id.slice(0, 200) : '';
    const label = typeof o.label === 'string' ? o.label.slice(0, 200) : '';
    const turns = Array.isArray(o.turns) ? o.turns : [];
    const intent = turns.map((t) => (t && typeof t.intent === 'string' ? t.intent.slice(0, 140) : null)).find(Boolean) ?? null;
    return {
      id,
      label,
      kind: kindOf(id),
      prefix: labelPrefix(label, id),
      review: ['pending', 'approved', 'rejected'].includes(o.review) ? o.review : null,
      intent,
      lines: 0,
      files: 0,
    };
  });

  // Lines per run, each line counted once even if ranges overlap.
  let left = MAX_RANGES;
  let files = 0;
  for (const [, list] of Object.entries(n.files ?? {})) {
    if (!Array.isArray(list) || left <= 0) continue;
    const ranges = [];
    for (const x of list) {
      if (left-- <= 0) break;
      if (!Array.isArray(x)) continue;
      const s = int(x[0], MAX_LINE);
      const e = int(x[1], MAX_LINE);
      const ri = int(x[2], MAX_RUNS - 1);
      if (s === null || e === null || ri === null || s < 1 || e < s || ri >= runs.length) continue;
      ranges.push([s, Math.min(e, s + MAX_SPAN - 1), ri]);
    }
    if (!ranges.length) continue;
    files++;
    ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let covered = 0;
    const here = new Set();
    for (const [s, e, ri] of ranges) {
      const from = Math.max(s, covered + 1);
      if (from <= e) {
        runs[ri].lines += e - from + 1;
        here.add(ri);
      }
      covered = Math.max(covered, e);
    }
    for (const ri of here) runs[ri].files++;
  }

  let ai = 0;
  let recorded = 0;
  for (const r of runs) {
    recorded += r.lines;
    if (isAiKind(r.kind)) ai += r.lines;
  }

  const c = n.commit && typeof n.commit === 'object' && !Array.isArray(n.commit) ? n.commit : {};
  const ts = whole(c.ts, 8.64e15);
  let added = whole(c.added, 1e9);
  // A note claiming more agent lines than the commit added is inconsistent:
  // trust the ranges (they name real lines) and widen the total.
  const inconsistent = added !== null && recorded > added;
  if (inconsistent) added = recorded;
  return {
    ts: ts && ts > 0 ? ts : null,
    added,
    defaultBranch: typeof c.default_branch === 'boolean' ? c.default_branch : null,
    runs,
    ai,
    recorded,
    files,
    inconsistent,
  };
}
