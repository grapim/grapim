export function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

export function who(row) {
  return row.label || row.agent;
}

function cut(s, n) {
  s = (s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// The WORKTREE column only when rows span more than one worktree; in a single
// worktree it would repeat the repo name on every row.
const worktreeCols = (cols, values) => (new Set(values.map((v) => v ?? '')).size > 1 ? cols : cols.filter((c) => c !== 'WORKTREE'));

function table(rows, cols) {
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  const line = (r) => cols.map((c, i) => String(r[c] ?? '').padEnd(widths[i])).join('  ').trimEnd();
  return [line(Object.fromEntries(cols.map((c) => [c, c]))), ...rows.map(line)].join('\n');
}

export function statusText(ws, store, now = Date.now()) {
  const leases = store.leases();
  const agents = store.activeAgents();
  const cols = (c) => worktreeCols(c, [...agents, ...leases].map((r) => r.worktree));
  const out = [];
  out.push(`Grapim · ${ws.repo} · ${agents.length} agent${agents.length === 1 ? '' : 's'} active · ${leases.length} file${leases.length === 1 ? '' : 's'} claimed`);
  out.push('');
  if (agents.length) {
    out.push(
      table(
        agents.map((a) => ({
          AGENT: who(a),
          WORKTREE: a.worktree ?? '',
          'WORKING ON': cut(a.intent, 60),
          'LAST SEEN': ago(now - a.last_seen) + ' ago',
        })),
        cols(['AGENT', 'WORKTREE', 'WORKING ON', 'LAST SEEN']),
      ),
    );
    out.push('');
  }
  if (leases.length) {
    out.push(
      table(
        leases.map((l) => ({
          FILE: l.path,
          'HELD BY': who(l),
          WORKTREE: l.worktree ?? '',
          FOR: cut(l.intent, 50),
          SINCE: ago(now - l.acquired_at),
        })),
        cols(['FILE', 'HELD BY', 'WORKTREE', 'FOR', 'SINCE']),
      ),
    );
  } else {
    out.push('No files claimed.');
  }
  return out.join('\n');
}

export function logText(store, limit, now = Date.now()) {
  const evs = store.events(limit);
  if (!evs.length) return 'No activity yet.';
  return evs
    .map((e) => {
      const t = new Date(e.ts).toLocaleTimeString([], { hour12: false });
      const what = {
        claim: `claimed ${e.path}${e.detail ? ` for "${cut(e.detail, 60)}"` : ''}`,
        release: `released ${e.path}`,
        edit: `edited ${e.path}${e.detail ? ` ${e.detail}` : ''}`,
        undo: `undid ${e.path} (${e.detail})`,
        blocked: `was stopped from editing ${e.path} (${e.detail})`,
        intent: `is now working on "${cut(e.detail, 70)}"`,
        end: 'ended its session',
        review: `was reviewed: ${e.detail}`,
        branch: `was put on branch ${e.detail}`,
      }[e.kind] ?? `${e.kind} ${e.path ?? ''}`;
      return `${t}  ${who(e)} ${what}`;
    })
    .join('\n');
}

// One line per file another agent holds, for telling an agent what to avoid.
export function othersText(store, agent, limit = 12) {
  const rows = store.leases().filter((l) => l.agent !== agent);
  if (!rows.length) return '';
  const lines = rows
    .slice(0, limit)
    .map((l) => `- ${l.path}: ${who(l)}${l.worktree ? ` (worktree ${l.worktree})` : ''}${l.intent ? `, for "${cut(l.intent, 80)}"` : ''}`);
  if (rows.length > limit) lines.push(`- and ${rows.length - limit} more`);
  return lines.join('\n');
}

export function runsText(rows, inTree, now = Date.now()) {
  if (!rows.length) return 'No recorded changes yet.';
  const data = rows.map((r) => ({
    RUN: who({ label: r.label, agent: r.run }),
    WORKTREE: r.worktree ?? r.root?.split(/[\\/]/).pop() ?? '',
    'WORKING ON': cut(r.intent, 40),
    TURNS: r.turns,
    FILES: r.files,
    '+': `+${r.added}`,
    '-': `-${r.removed}`,
    'IN TREE': inTree.get(r.run) ?? '?',
    REVIEW: r.review?.status ?? 'pending',
    LAST: ago(now - r.last_ts) + ' ago',
  }));
  // REVIEW only when the caller looked reviews up (rows carry a review key).
  const cols = ['RUN', 'WORKTREE', 'WORKING ON', 'TURNS', 'FILES', '+', '-', 'IN TREE', ...('review' in rows[0] ? ['REVIEW'] : []), 'LAST'];
  return table(data, worktreeCols(cols, data.map((r) => r.WORKTREE)));
}

export function blameText(b) {
  if (b.untracked) return `${b.path}: binary or over 2 MB, so lines cannot be attributed. Changed by: ${b.runs.join(', ') || 'nobody recorded'}.`;
  if (!b.exists) return `${b.path} does not exist in the working tree.`;
  if (!b.lines.length) return `${b.path}: no lines differ from ${b.base}.${b.removed ? ` ${b.removed} removed.` : ''}`;
  // Run and turn are separate columns, so "turn N" lines up under labels of different lengths.
  const who = b.lines.map((l) => (l.run ? l.label || l.run : l.label));
  const turns = b.lines.map((l) => (l.run ? `turn ${l.turn}` : ''));
  const w = Math.max(...who.map((s) => s.length));
  const tw = Math.max(...turns.map((s) => s.length));
  const n = String(b.lines.at(-1).line).length;
  const out = [`${b.path} · ${b.lines.length} ${b.lines.length === 1 ? 'line differs' : 'lines differ'} from ${b.base}`, ''];
  b.lines.forEach((l, i) => out.push(`${String(l.line).padStart(n)}  ${who[i].padEnd(w)}  ${tw ? `${turns[i].padEnd(tw)}  ` : ''}| ${l.text}`));
  if (b.removed) out.push('', `${b.removed} line${b.removed === 1 ? '' : 's'} removed (not shown).`);
  return out.join('\n');
}

const DONE = { revert: 'reverted', delete: 'deleted', restore: 'restored', conflict: 'conflict', nothing: 'nothing', skipped: 'skipped' };
const WHY = { revert: 'its edits removed, later work by others kept', delete: 'created by this run', restore: 'deleted by this run', nothing: 'its changes are already gone' };

export function undoText(plan, applied = false) {
  const name = `${plan.run.label || plan.run.run}${plan.turn === null ? '' : ` turn ${plan.turn}`}`;
  const out = [`Undo ${name} · ${plan.files.length} file${plan.files.length === 1 ? '' : 's'}`, ''];
  const w = Math.max(...plan.files.map((f) => f.path.length));
  for (const f of plan.files) {
    const verb = applied ? DONE[f.action] : f.action;
    const via = f.via ? ` (via shell: ${f.via})` : '';
    out.push(`  ${verb.padEnd(9)} ${f.path.padEnd(w)}  ${f.reason ?? WHY[f.action] ?? ''}${via}`.trimEnd());
  }
  const count = (a) => plan.files.filter((f) => f.action === a).length;
  const clean = count('revert') + count('delete') + count('restore');
  const conflicts = count('conflict');
  out.push('');
  if (applied) out.push(`Done: ${clean} file${clean === 1 ? '' : 's'} changed.${conflicts ? ` Left ${conflicts} file${conflicts === 1 ? '' : 's'} with conflicts untouched.` : ''}${count('skipped') ? ` Skipped ${count('skipped')}.` : ''}`);
  else out.push(clean ? `Nothing was changed. Run again with --yes to apply the ${clean} clean one${clean === 1 ? '' : 's'}${conflicts ? '; conflicts are left alone' : ''}.` : 'Nothing was changed, and there is nothing clean to apply.');
  return out.join('\n');
}

const RESTORE = { create: 'create', replace: 'replace', nothing: 'nothing' };

// The plan (or result) of `grapim restore`, with the diff from the current
// file to the version. diff: { hunks } from json-diff.js, or null when the
// current file is binary or over 2 MB.
export function restoreText(plan, applied = false, diff = null) {
  const short = plan.sha.slice(0, 8);
  const from = plan.from;
  const origin = `${from.side === 'after' ? 'after' : 'before'} ${from.label}${from.turn ? ` turn ${from.turn}` : ''}, ${ago(Date.now() - from.ts)} ago`;
  const pm = plan.added === null ? 'binary' : `+${plan.added} -${plan.removed}`;
  const out = [`Restore ${plan.path} to ${short} (${origin}) · ${RESTORE[plan.action]}${plan.action === 'nothing' ? '' : `, ${pm}`}`];
  if (plan.action === 'nothing') {
    out.push('', 'The file already has this content. Nothing to do.');
    return out.join('\n');
  }
  if (diff) {
    for (const h of diff.hunks) {
      out.push('', `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
      for (const l of h.lines) out.push(`${l.t}${l.s}`);
    }
  }
  out.push('');
  if (applied) out.push(`Done: restored ${plan.path} to ${short}. Recorded as run ${plan.run}; to take it back: grapim undo ${plan.run} --yes`);
  else if (plan.reason) out.push(`Nothing was changed. The file is ${plan.reason}, so --yes will refuse until it is free.`);
  else out.push('Nothing was changed. Run again with --yes to restore it.');
  return out.join('\n');
}
