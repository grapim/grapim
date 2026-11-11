// `grapim blame <file> --history`: every line of the file, committed or not,
// with the agent run, turn and prompt that wrote it, or human/unknown.
//
// Committed lines: `git blame --line-porcelain` gives, per line, the commit
// that introduced it and the line's number and path in that commit, which is
// exactly how notes address lines. Uncommitted lines come from the live ledger
// (attribution.js blame), as plain `grapim blame` shows them.

import fs from 'node:fs';
import path from 'node:path';
import { blame } from '../attribution.js';
import { splitLines } from '../diff.js';
import { kindOf, lookupLine, parseNote } from './note.js';
import { listNotes, readBlobs, tryGit } from './git.js';
import { runInfo } from './record.js';

const ZERO = /^0{40}$/;

// [{ commit, origLine, finalLine, filename, text }] or null if git cannot blame it.
function gitBlame(root, display) {
  const out = tryGit(root, ['blame', '--line-porcelain', '--no-textconv', '--', display]);
  if (out === null) return null;
  const rows = [];
  let cur = null;
  for (const line of out.split('\n')) {
    if (cur === null) {
      const m = /^([0-9a-f]{40}) (\d+) (\d+)/.exec(line);
      if (m) cur = { commit: m[1], origLine: Number(m[2]), finalLine: Number(m[3]), filename: display };
      continue;
    }
    if (line.startsWith('filename ')) cur.filename = line.slice(9);
    else if (line.startsWith('\t')) {
      cur.text = line.slice(1).replace(/\r$/, '');
      rows.push(cur);
      cur = null;
    }
  }
  return rows;
}

// commit -> parsed note, for the given commits (unreadable notes are skipped).
export function notesFor(root, commits) {
  const index = listNotes(root);
  const blobs = [...new Set(commits)].filter((c) => index.has(c)).map((c) => [c, index.get(c)]);
  const texts = readBlobs(root, blobs.map(([, b]) => b));
  const out = new Map();
  for (const [c, b] of blobs) {
    try {
      out.set(c, parseNote(texts.get(b) ?? ''));
    } catch {}
  }
  return out;
}

const UNKNOWN = Object.freeze({ run: null, label: 'human/unknown', kind: null, turn: null, intent: null, review: null });

export function blameHistory(ws, store, file) {
  const abs = path.join(ws.root, file.display);
  const rows = ws.isGit ? gitBlame(ws.root, file.display) : null;
  const live = blame(store, ws, file);
  const liveBy = new Map((live.lines ?? []).map((l) => [l.line, l]));
  const infos = new Map();
  const info = (run) => {
    if (!infos.has(run)) infos.set(run, runInfo(store, run));
    return infos.get(run);
  };
  const fromLedger = (n) => {
    const l = liveBy.get(n);
    if (!l?.run) return UNKNOWN;
    const i = info(l.run);
    return { run: l.run, label: l.label || i.label, kind: kindOf(l.run), turn: l.turn, intent: i.intent(l.turn), review: i.review };
  };

  let lines;
  if (rows) {
    const notes = notesFor(ws.root, rows.filter((r) => !ZERO.test(r.commit)).map((r) => r.commit));
    lines = rows.map((r) => {
      if (ZERO.test(r.commit)) return { line: r.finalLine, text: r.text, commit: null, source: 'ledger', ...fromLedger(r.finalLine) };
      const hit = lookupLine(notes.get(r.commit), r.filename, r.origLine);
      return { line: r.finalLine, text: r.text, commit: r.commit, source: hit ? 'note' : null, ...(hit ?? UNKNOWN) };
    });
  } else {
    // Not in git (a new file, or no repo): every line is uncommitted.
    let buf = Buffer.alloc(0);
    try {
      buf = fs.readFileSync(abs);
    } catch {}
    lines = splitLines(buf).map((l, i) => ({
      line: i + 1,
      text: Buffer.from(l, 'latin1').toString('utf8').replace(/\r?\n$/, ''),
      commit: null,
      source: 'ledger',
      ...fromLedger(i + 1),
    }));
  }
  for (const l of lines) if (l.source === 'ledger' && !l.run) l.source = null;

  const runs = new Map();
  for (const l of lines) {
    if (!l.run) continue;
    const k = `${l.run}|${l.turn}`;
    if (!runs.has(k)) runs.set(k, { run: l.run, label: l.label, kind: l.kind, turn: l.turn, intent: l.intent, review: l.review, lines: 0 });
    runs.get(k).lines++;
  }
  return {
    path: file.display,
    lines,
    agentLines: lines.filter((l) => l.run).length,
    turns: [...runs.values()],
    untracked: !!live.untracked,
  };
}

const pad = (s, n) => String(s).padEnd(n);

export function historyText(h) {
  if (!h.lines.length) return `${h.path}: empty or not found.`;
  const nRuns = new Set(h.turns.map((t) => t.run)).size;
  const head = `${h.path}: ${h.lines.length} line${h.lines.length === 1 ? '' : 's'}, ${h.agentLines} written by agents${nRuns ? ` (${nRuns} run${nRuns === 1 ? '' : 's'})` : ''}`;
  const lw = String(h.lines.at(-1).line).length;
  const ww = Math.max(13, ...h.lines.map((l) => (l.run ? l.label.length : 0)));
  const body = h.lines.map((l) => {
    const who = l.run ? l.label : 'human/unknown';
    const turn = l.run ? `turn ${l.turn}` : '';
    const where = l.commit ? l.commit.slice(0, 8) : 'uncommitted';
    return `${String(l.line).padStart(lw)}  ${pad(who, ww)}  ${pad(turn, 8)}  ${pad(where, 11)} | ${l.text}`;
  });
  const prompts = h.turns
    .filter((t) => t.intent)
    .map((t) => `  ${t.label} turn ${t.turn}: "${t.intent}" (${t.lines} line${t.lines === 1 ? '' : 's'}, review ${t.review ?? 'pending'})`);
  return [head, '', ...body, ...(prompts.length ? ['', 'Prompts:', ...prompts] : [])].join('\n') + (h.untracked ? '\n\nSome uncommitted changes were not recorded (binary or over 2 MB).' : '');
}
