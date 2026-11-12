// CSV export for each report. RFC 4180 quoting, CRLF line ends, and no
// formula injection: a text cell that a spreadsheet would run as a formula
// (labels and intents are synced input) gets a leading apostrophe.

const cell = (v) => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(Math.round(v * 10000) / 10000) : '';
  let s = String(v);
  // A formula start, also after leading whitespace or as its full-width form
  // (some spreadsheets read both), and a leading tab, CR or LF.
  if (/^[\s\u3000]*[=+\-@\uff1d\uff0b\uff0d\uff20]|^[\t\r\n]/.test(s)) s = `'${s}`;
  // Quote on ";" and tabs too: spreadsheets in many locales split CSV on ";",
  // and an unquoted "x;=cmd|..." would start a new cell with a formula.
  return /[",;\t\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const table = (head, rows) => [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : '');

export function toCsv(name, r) {
  switch (name) {
    case 'ai-share':
      return table(
        ['week_start', 'commits', 'commits_with_totals', 'ai_lines', 'human_lines', 'added_lines', 'ai_share', ...r.kinds.map((k) => `ai_lines_${k}`)],
        r.weeks.map((w) => [w.week, w.commits, w.commits_with_totals, w.ai, w.human, w.added, w.share, ...r.kinds.map((k) => w.by_kind[k] ?? 0)]),
      );
    case 'agents':
      return table(
        ['kind', 'label_prefix', 'runs', 'reviewed', 'approved', 'rejected', 'pending', 'undone', 'undo_rate', 'reject_rate', 'median_review_hours', 'lines_written', 'lines_committed'],
        r.agents.map((g) => [g.kind, g.prefix, g.runs, g.reviewed, g.approved, g.rejected, g.pending, g.undone, g.undo_rate, g.reject_rate, g.median_review_ms === null ? null : g.median_review_ms / 3_600_000, g.lines_written, g.lines_committed]),
      );
    case 'unreviewed':
      return table(
        ['repo', 'run', 'label', 'kind', 'status', 'lines', 'files', 'commits', 'first_commit', 'last_commit', 'intent'],
        r.runs.map((u) => [u.repo_name, u.run, u.label, u.kind, u.status, u.lines, u.files, u.commits, iso(u.first_ts), iso(u.last_ts), u.intent]),
      );
    case 'activity':
      return table(
        ['date', 'runs', 'files_touched', 'edits', 'blocks', 'conflicts'],
        r.days.map((d) => [d.date, d.runs, d.files, d.edits, d.blocks, d.conflicts]),
      );
    default:
      throw new Error(`no CSV for ${name}`);
  }
}

// Any table: a header row and rows of cells, with the same quoting and
// formula defusing (the history scan and the audit evidence use it).
export const csvTable = (head, rows) => table(head, rows);
