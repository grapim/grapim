// `grapim provenance record|show|stats|push` and `grapim blame --history`.
// (`grapim provenance pr` is handled in src/provenance/pr-command.js.)

import { blameHistory, historyText } from './history.js';
import { noteCounts } from './note.js';
import { pushNotes, recordCommit, showNote } from './record.js';
import { provenanceStats, statsText } from './stats.js';

const USAGE = `Usage:
  grapim provenance record [<commit>]      write the AI provenance note of a commit (default HEAD)
  grapim provenance show [<commit>] [--json]
  grapim provenance stats [<rev-range>] [--json]
  grapim provenance push [<remote>]        push refs/notes/grapim (default origin)
  grapim provenance pr <base>..<head> [--json]`;

export function noteText(commit, note) {
  if (!note) return `${commit.slice(0, 12)}: no provenance note (not recorded: unknown who wrote it).`;
  const added = note.commit?.added;
  if (!note.runs.length) return `${commit.slice(0, 12)}: recorded, no lines written by AI agents${added === undefined ? '' : ` (${added} line${added === 1 ? '' : 's'} added by people)`}.`;
  const counts = noteCounts(note);
  const out = [`${commit.slice(0, 12)}: ${counts.total} line${counts.total === 1 ? '' : 's'} written by AI agents${note.truncated ? ' (note truncated)' : ''}`];
  note.runs.forEach((r, i) => {
    out.push('', `  ${r.label} (${r.kind}, review ${r.review}): ${counts.runs[i]} line${counts.runs[i] === 1 ? '' : 's'}`);
    for (const t of r.turns) out.push(`    turn ${t.turn}${t.intent ? `: "${t.intent}"` : ''}`);
  });
  out.push('', '  Files:');
  for (const [p, ranges] of Object.entries(note.files)) {
    const spans = ranges.map(([s, e, r, t]) => `${s === e ? s : `${s}-${e}`} (${note.runs[r].label} t${t})`);
    out.push(`    ${p}: ${spans.join(', ')}`);
  }
  return out.join('\n');
}

export async function provenanceMain(store, ws, rest, flags, { term = String } = {}) {
  const [sub, arg] = rest;
  if (!ws.isGit && sub !== undefined) {
    console.error('Provenance needs a git repo.');
    return 1;
  }
  try {
    switch (sub) {
      case 'record': {
        const r = recordCommit(ws, store, arg || 'HEAD', { hook: !!flags.hook });
        if (flags.json) console.log(JSON.stringify(r, null, 2));
        else if (!flags.hook) {
          const where = r.target && r.target !== r.commit ? ` (on ${r.target.slice(0, 12)}, which git copies to the amended commit)` : '';
          console.log(term(r.written ? noteText(r.commit, r.note) + where : `${r.commit.slice(0, 12)}: ${r.reason}${r.note ? '' : ', no note written'}.`));
          for (const s of r.skipped ?? []) console.log(term(`  skipped ${s.path}: ${s.reason}`));
        }
        return 0;
      }
      case 'show': {
        const r = showNote(ws, arg || 'HEAD');
        console.log(flags.json ? JSON.stringify(r, null, 2) : term(noteText(r.commit, r.note)));
        return 0;
      }
      case 'stats': {
        const s = provenanceStats(ws, arg || 'HEAD');
        console.log(flags.json ? JSON.stringify(s, null, 2) : term(statsText(s)));
        return 0;
      }
      case 'push': {
        // The pre-push hook ignores the exit code: a failure never blocks a push.
        const r = pushNotes(ws, arg || 'origin');
        (r.ok ? console.log : console.error)(term(r.message));
        return r.ok ? 0 : 1;
      }
      default:
        console.error(USAGE);
        return sub ? 1 : 0;
    }
  } catch (err) {
    console.error(term(`grapim provenance ${sub}: ${err.message}`));
    return 1;
  }
}

export function blameHistoryCmd(store, ws, file, flags, { term = String } = {}) {
  const h = blameHistory(ws, store, file);
  console.log(flags.json ? JSON.stringify(h, null, 2) : term(historyText(h)));
  return 0;
}
