// `grapim provenance stats [<rev-range>]`: the share of added lines written
// by AI agents over a range of commits, per agent run, per kind and per file.
// Added lines come from `git log --numstat` (merges excluded, as notes are
// never written for them; binary files count 0); AI lines from the notes.

import { noteCounts } from './note.js';
import { git } from './git.js';
import { notesFor } from './history.js';

// [{ commit, files: [{ path, added }] }] for the non-merge commits in range.
function numstat(root, range) {
  const out = git(root, ['log', '--no-merges', '-M', '--numstat', '-z', '--no-ext-diff', '--no-textconv', '--format=@@%H', range, '--']);
  const commits = [];
  const toks = out.split('\0');
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i].replace(/^\n+/, '');
    if (!t) continue;
    if (t.startsWith('@@')) {
      commits.push({ commit: t.slice(2).trim(), files: [] });
      continue;
    }
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(t);
    if (!m || !commits.length) continue;
    let p = m[3];
    if (p === '') {
      i += 2; // a rename: old path, new path
      p = toks[i];
    }
    commits.at(-1).files.push({ path: p, added: m[1] === '-' ? 0 : Number(m[1]) });
  }
  return commits;
}

const share = (ai, added) => (added ? Math.round((ai / added) * 1000) / 10 : 0);

export function provenanceStats(ws, range = 'HEAD') {
  const commits = numstat(ws.root, range);
  const notes = notesFor(ws.root, commits.map((c) => c.commit));
  const files = new Map();
  const runs = new Map();
  const kinds = new Map();
  let added = 0;
  let ai = 0;
  for (const c of commits) {
    const note = notes.get(c.commit);
    const counts = note ? noteCounts(note) : null;
    for (const f of c.files) {
      if (!files.has(f.path)) files.set(f.path, { path: f.path, added: 0, ai: 0 });
      const row = files.get(f.path);
      // Never more AI lines than the commit added to the file (merged notes).
      const n = Math.min(counts?.files[f.path] ?? 0, f.added);
      row.added += f.added;
      row.ai += n;
      added += f.added;
      ai += n;
    }
    if (!note) continue;
    note.runs.forEach((r, i) => {
      const lines = counts.runs[i];
      if (!lines) return;
      if (!runs.has(r.id)) runs.set(r.id, { run: r.id, label: r.label, kind: r.kind, review: r.review, lines: 0, commits: 0, files: new Set() });
      const row = runs.get(r.id);
      row.lines += lines;
      row.commits++;
      row.review = r.review;
      for (const [p, ranges] of Object.entries(note.files)) if (ranges.some((x) => x[2] === i)) row.files.add(p);
      kinds.set(r.kind, (kinds.get(r.kind) ?? 0) + lines);
    });
  }
  return {
    range,
    commits: commits.length,
    withNotes: commits.filter((c) => notes.has(c.commit)).length,
    added,
    ai,
    share: share(ai, added),
    agents: [...runs.values()].map((r) => ({ ...r, files: r.files.size, share: share(r.lines, added) })).sort((a, b) => b.lines - a.lines),
    kinds: [...kinds].map(([kind, lines]) => ({ kind, lines, share: share(lines, added) })).sort((a, b) => b.lines - a.lines),
    files: [...files.values()].filter((f) => f.added).map((f) => ({ ...f, share: share(f.ai, f.added) })).sort((a, b) => b.ai - a.ai || b.added - a.added || (a.path < b.path ? -1 : 1)),
  };
}

export function statsText(s) {
  const out = [`${s.range}: ${s.commits} commit${s.commits === 1 ? '' : 's'} (${s.withNotes} recorded), ${s.added} lines added, ${s.ai} by AI agents (${s.share}%)`];
  if (s.agents.length) {
    out.push('', 'By agent run:');
    const w = Math.max(...s.agents.map((a) => a.label.length));
    for (const a of s.agents) out.push(`  ${a.label.padEnd(w)}  ${a.kind.padEnd(11)}  ${String(a.lines).padStart(6)} lines  ${String(a.share).padStart(5)}%  ${a.files} file${a.files === 1 ? '' : 's'}  review ${a.review}`);
    out.push('', 'By kind:');
    for (const k of s.kinds) out.push(`  ${k.kind.padEnd(11)}  ${String(k.lines).padStart(6)} lines  ${String(k.share).padStart(5)}%`);
  }
  const touched = s.files.filter((f) => f.ai);
  if (touched.length) {
    out.push('', 'By file (files with AI lines):');
    const w = Math.max(...touched.map((f) => f.path.length));
    for (const f of touched.slice(0, 50)) out.push(`  ${f.path.padEnd(w)}  ${String(f.ai).padStart(6)} of ${String(f.added).padStart(6)}  ${String(f.share).padStart(5)}%`);
    if (touched.length > 50) out.push(`  … ${touched.length - 50} more (--json for all)`);
  }
  return out.join('\n');
}
