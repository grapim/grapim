// The review plan: what a pull request changed, who wrote each hunk, how deep
// to look at it, and how the hunks go to the model in batches.
//
//   collectChanges({ cwd, base, head, config }) reads git: the diff of
//   base...head (from the merge base, 3 lines of context, --no-ext-diff and
//   --no-textconv so nothing from the repo runs), `git blame` of the added
//   lines and the provenance notes of the commits that introduced them
//   (src/provenance/pr.js, render.js; docs/provenance.md section 1). Lines with
//   no note are human or unknown.
//   planReview(changes, config, limits) is pure: depth per hunk, batches.

import { git, blameRanges, hasNotesRef, readNotes, resolveCommit, GitError } from '../provenance/pr.js';
import { attribute } from '../provenance/render.js';
import { matcher } from './config.js';

export const CHARS_PER_TOKEN = 4;
export const DEFAULT_LIMITS = Object.freeze({
  batchTokens: 30_000, // diff and file text per request
  maxInputTokens: 600_000, // per review, estimated
  fileContextChars: 24_000, // whole file text sent when the file is at most this big (0: never)
  contextLines: 3, // unchanged lines shown around each hunk (git diff -U)
  hunkChars: 60_000, // a hunk bigger than this is cut into pieces
  maxDiffFiles: 3000, // files looked at, at most
});

// Runs of these kinds are people's (docs/provenance.md section 6): folder
// sync, undo and restore write what a person decided.
const PEOPLE_KINDS = new Set(['sync', 'undo', 'restore']);
export const isAgentKind = (kind) => !PEOPLE_KINDS.has(kind);

export const estimateTokens = (chars) => Math.ceil(chars / CHARS_PER_TOKEN);
const DEPTH_RANK = { low: 1, medium: 2, high: 3 };
export const maxDepth = (a, b) => ((DEPTH_RANK[a] ?? 0) >= (DEPTH_RANK[b] ?? 0) ? a : b);

// The default branch's tip, for a base that was not given.
function defaultBase(cwd, headSha) {
  const sym = git(cwd, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { allowFail: true });
  const candidates = [sym?.trim(), 'refs/remotes/origin/main', 'refs/remotes/origin/master', 'refs/heads/main', 'refs/heads/master'].filter(Boolean);
  for (const c of candidates) {
    const sha = resolveCommit(cwd, c);
    if (sha && sha !== headSha) return sha;
  }
  throw new GitError('No base commit was given and no default branch (origin/HEAD, main or master) was found. Pass the base commit.');
}

// `git diff --numstat -z`: one entry per diff section, in the same order.
function numstat(cwd, from, to) {
  const parts = git(cwd, ['diff', '--numstat', '-z', '-M', '--no-ext-diff', '--no-textconv', from, to]).split('\0');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(parts[i]);
    if (!m) continue;
    let p = m[3];
    let oldPath = null;
    if (p === '') {
      oldPath = parts[++i];
      p = parts[++i];
    }
    out.push({ path: p, oldPath, binary: m[1] === '-' });
  }
  return out;
}

// Unified diff text -> sections: [{ status, hunks: [{ oldStart, newStart, lines }] }].
// A hunk is read by its header's counts, so file content that looks like a
// diff header never starts a new section.
export function parseUnifiedDiff(text) {
  const rows = text.split('\n');
  const sections = [];
  let cur = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.startsWith('diff --git ')) {
      cur = { status: 'modified', hunks: [] };
      sections.push(cur);
      continue;
    }
    if (!cur) continue;
    if (row.startsWith('new file mode')) cur.status = 'added';
    else if (row.startsWith('deleted file mode')) cur.status = 'deleted';
    else if (row.startsWith('rename from ')) cur.status = 'renamed';
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(row);
    if (!m) continue;
    let oldLeft = m[2] === undefined ? 1 : Number(m[2]);
    let newLeft = m[4] === undefined ? 1 : Number(m[4]);
    let oldLine = Number(m[1]);
    let newLine = Number(m[3]);
    const hunk = { oldStart: oldLine, newStart: newLine, lines: [] };
    while ((oldLeft > 0 || newLeft > 0) && i + 1 < rows.length) {
      const l = rows[++i];
      const t = l[0];
      const body = l.slice(1).replace(/\r$/, '');
      if (t === '\\') continue; // "\ No newline at end of file"
      if (t === '+') {
        hunk.lines.push({ type: '+', text: body, newLine: newLine++ });
        newLeft--;
      } else if (t === '-') {
        hunk.lines.push({ type: '-', text: body, oldLine: oldLine++ });
        oldLeft--;
      } else {
        hunk.lines.push({ type: ' ', text: body, newLine: newLine++, oldLine: oldLine++ });
        oldLeft--;
        newLeft--;
      }
    }
    // A trailing "\ No newline" after the last counted line.
    if (rows[i + 1]?.startsWith('\\')) i++;
    cur.hunks.push(hunk);
  }
  return sections;
}

const addedOf = (lines) => lines.filter((l) => l.type === '+').map((l) => l.newLine);
const charsOf = (lines) => lines.reduce((n, l) => n + l.text.length + 10, 0);

// [[s, e], ...] from sorted line numbers.
export function rangesOf(lines) {
  const out = [];
  for (const n of [...lines].sort((a, b) => a - b)) {
    const last = out.at(-1);
    if (last && n === last[1] + 1) last[1] = n;
    else if (!last || n > last[1]) out.push([n, n]);
  }
  return out;
}

// Cuts a hunk's lines into pieces of at most maxChars (at least one line each).
export function splitLines(lines, maxChars) {
  const pieces = [];
  let cur = [];
  let size = 0;
  for (const l of lines) {
    const c = l.text.length + 10;
    if (cur.length && size + c > maxChars) {
      pieces.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(l);
    size += c;
  }
  if (cur.length) pieces.push(cur);
  return pieces;
}

// Builds hunk objects for one file, attributing each hunk's added lines.
function makeHunk(path, lines, ctx) {
  const added = addedOf(lines);
  const a = added.length ? attribute({ files: [{ path, added: rangesOf(added) }], notesByCommit: ctx.notesByCommit, blameByFile: { [path]: ctx.blame } }) : { runs: [] };
  const runs = a.runs.map((r) => ({ id: r.id, label: r.label, kind: r.kind, lines: r.lines, intents: r.turns.filter((t) => t.intent).map((t) => t.intent) }));
  const agentRuns = runs.filter((r) => isAgentKind(r.kind));
  const first = lines.find((l) => l.newLine !== undefined)?.newLine ?? null;
  const last = [...lines].reverse().find((l) => l.newLine !== undefined)?.newLine ?? null;
  return { path, lines, added, runs: agentRuns, peopleRuns: runs.filter((r) => !isAgentKind(r.kind)), ai: agentRuns.length > 0, newStart: first, newEnd: last, chars: charsOf(lines) };
}

// Everything the plan needs, read from git.
export function collectChanges({ cwd, base, head = 'HEAD', config, limits = {} }) {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const headSha = resolveCommit(cwd, head);
  if (!headSha) throw new GitError(`${head} is not a commit in this repository.`);
  const baseSha = base ? resolveCommit(cwd, base) : defaultBase(cwd, headSha);
  if (!baseSha) throw new GitError(`${base} is not a commit in this repository.`);
  const mergeBase = (git(cwd, ['merge-base', baseSha, headSha], { allowFail: true }) ?? '').trim() || baseSha;

  const isIgnored = matcher(config.ignore ?? []);
  const isSensitive = matcher(config.sensitive ?? []);
  const stat = numstat(cwd, mergeBase, headSha);
  const contextLines = Math.max(0, Math.min(100, Math.trunc(lim.contextLines) || 0));
  const sections = parseUnifiedDiff(git(cwd, ['diff', `-U${contextLines}`, '-M', '--no-color', '--no-ext-diff', '--no-textconv', mergeBase, headSha]));
  const withNotes = hasNotesRef(cwd);

  const files = [];
  const blames = {};
  const toBlame = [];
  stat.forEach((s, i) => {
    const sec = sections[i] ?? { status: 'modified', hunks: [] };
    const f = { path: s.path, oldPath: s.oldPath, status: s.oldPath && sec.status === 'modified' ? 'renamed' : sec.status, binary: s.binary, sensitive: isSensitive(s.path), ignored: isIgnored(s.path), hunks: [], rawHunks: sec.hunks, skip: null };
    if (f.ignored) f.skip = 'ignored by .grapim/review.json';
    else if (f.binary) f.skip = 'binary file';
    else if (f.status === 'deleted') f.skip = 'file deleted (no new lines to comment on)';
    else if (!sec.hunks.some((h) => h.lines.some((l) => l.type === '+'))) f.skip = sec.hunks.length ? 'only removed lines (nothing to comment on)' : 'no content change';
    else if (toBlame.length >= lim.maxDiffFiles) f.skip = `over the ${lim.maxDiffFiles}-file limit of one review`;
    else toBlame.push(f);
    files.push(f);
  });

  for (const f of toBlame) blames[f.path] = withNotes ? blameRanges(cwd, headSha, f.path, rangesOf(f.rawHunks.flatMap((h) => addedOf(h.lines)))) : [];
  const commits = new Set(Object.values(blames).flatMap((b) => b.map((g) => g.commit)));
  const notesByCommit = withNotes && commits.size ? readNotes(cwd, [...commits]) : {};

  for (const f of files) {
    const ctx = { notesByCommit, blame: blames[f.path] ?? [] };
    for (const h of f.rawHunks) {
      for (const piece of splitLines(h.lines, lim.hunkChars)) {
        const hunk = makeHunk(f.path, piece, f.skip ? { notesByCommit: {}, blame: [] } : ctx);
        hunk.sensitive = f.sensitive;
        hunk.index = f.hunks.length;
        f.hunks.push(hunk);
      }
    }
    delete f.rawHunks;
  }
  return { base: baseSha, head: headSha, mergeBase, files, notesByCommit, blames, hasNotes: withNotes };
}

// The agent run that wrote one line of the head, or null (human or unknown).
export function runAtLine(changes, path, line) {
  const a = attribute({ files: [{ path, added: [[line, line]] }], notesByCommit: changes.notesByCommit, blameByFile: { [path]: changes.blames[path] ?? [] } });
  const r = a.runs.find((x) => isAgentKind(x.kind));
  return r ? { id: r.id, kind: r.kind, intent: r.intent ?? null, label: r.label } : null;
}

// Depth of one hunk (docs/design-ai-review.md, "Depth per hunk"): agent-written
// and sensitive -> high, agent-written -> medium, sensitive human-written ->
// medium, other human-written -> skipped (low under "all"). "ai-only" reviews
// agent-written hunks only. planReview turns the default into "all" for a
// repository that has no notes.
export function depthOf(hunk, mode) {
  if (hunk.ai) return hunk.sensitive ? 'high' : 'medium';
  if (mode === 'ai-only') return null;
  if (hunk.sensitive) return 'medium';
  return mode === 'all' ? 'low' : null;
}

const humanReason = (mode, sensitive) =>
  mode === 'ai-only' ? 'human-written ("review": "ai-only")' : sensitive ? 'human-written' : 'human-written, not on a sensitive path';

// The plan: { batches, skipped, stats }. A batch is { id, effort, units:
// [{ path, hunks, context, fileText }], tokens }. Hunks with no added line
// ride along as context of their file when the file has reviewed hunks.
// fileText(path) -> the file at the head (or null), only called for files
// small enough to send whole.
export function planReview(changes, config, { limits = {}, fileText = () => null } = {}) {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  // A repository with no Grapim notes at all says nothing about who wrote what:
  // its lines are unknown, not human. The default would then skip nearly every
  // line (a team's first review would cover only the sensitive paths), so
  // without notes it reviews everything. "ai-only" stays as asked.
  const asked = config.review ?? 'ai-and-sensitive';
  const noNotes = changes.hasNotes === false;
  const mode = asked === 'ai-and-sensitive' && noNotes ? 'all' : asked;
  const skipped = [];
  const stats = { files: changes.files.length, hunks: 0, aiHunks: 0, plannedHunks: 0, skippedHunks: 0, noNotes };
  const units = [];
  for (const f of changes.files) {
    stats.hunks += f.hunks.length;
    stats.aiHunks += f.hunks.filter((h) => h.ai).length;
    if (f.skip) {
      stats.skippedHunks += f.hunks.length;
      skipped.push({ path: f.path, reason: f.skip });
      continue;
    }
    for (const h of f.hunks) h.depth = h.added.length ? depthOf(h, mode) : null;
    const chosen = f.hunks.filter((h) => h.depth);
    if (!chosen.length) {
      stats.skippedHunks += f.hunks.length;
      skipped.push({ path: f.path, reason: humanReason(mode, f.sensitive) });
      continue;
    }
    stats.skippedHunks += f.hunks.length - chosen.length;
    const context = f.hunks.filter((h) => !h.depth);
    units.push({ path: f.path, status: f.status, oldPath: f.oldPath, sensitive: f.sensitive, hunks: chosen, context, depth: chosen.map((h) => h.depth).reduce(maxDepth) });
  }

  // Riskiest files first: maxFiles and the token budget cut from the bottom.
  units.sort((a, b) => DEPTH_RANK[b.depth] - DEPTH_RANK[a.depth]);
  const maxFiles = config.maxFiles ?? 100;
  for (const u of units.splice(maxFiles)) {
    stats.skippedHunks += u.hunks.length;
    skipped.push({ path: u.path, reason: `over the maxFiles limit (${maxFiles})` });
  }

  const budgetChars = lim.batchTokens * CHARS_PER_TOKEN;
  // Pieces: a file whole when it fits in a batch, else its hunks in runs that fit.
  const pieces = [];
  for (const u of units) {
    const hunkChars = u.hunks.reduce((n, h) => n + h.chars, 0) + u.context.reduce((n, h) => n + h.chars, 0);
    // The whole file is context for a change to part of it. A new file, or one
    // the change mostly rewrites, is already in the diff: sending it again
    // would pay for the same lines twice.
    let text = null;
    if (u.status !== 'deleted' && u.status !== 'added' && lim.fileContextChars > 0) {
      const t = fileText(u.path);
      const added = u.hunks.reduce((n, h) => n + h.added.length, 0);
      if (typeof t === 'string' && t.length <= lim.fileContextChars && !t.includes('\u0000') && t.length + hunkChars <= budgetChars && added * 2 < t.split('\n').length) text = t;
    }
    if (hunkChars + (text?.length ?? 0) <= budgetChars) {
      pieces.push({ ...u, fileText: text, chars: hunkChars + (text?.length ?? 0) });
      continue;
    }
    let cur = [];
    let size = 0;
    for (const h of u.hunks) {
      if (cur.length && size + h.chars > budgetChars) {
        pieces.push({ ...u, hunks: cur, context: [], fileText: null, chars: size });
        cur = [];
        size = 0;
      }
      cur.push(h);
      size += h.chars;
    }
    if (cur.length) pieces.push({ ...u, hunks: cur, context: [], fileText: null, chars: size });
  }

  // Batches: pieces of the same depth packed under the batch budget, and the
  // whole review under maxInputTokens.
  const batches = [];
  let spent = 0;
  for (const depth of ['high', 'medium', 'low']) {
    let cur = null;
    for (const p of pieces.filter((x) => x.depth === depth)) {
      const tokens = estimateTokens(p.chars);
      if (spent + tokens > lim.maxInputTokens) {
        stats.skippedHunks += p.hunks.length;
        skipped.push({ path: p.path, reason: 'over the input-token budget of one review' });
        continue;
      }
      spent += tokens;
      if (!cur || cur.tokens + tokens > lim.batchTokens) {
        cur = { id: batches.length + 1, effort: depth, units: [], tokens: 0 };
        batches.push(cur);
      }
      cur.units.push(p);
      cur.tokens += tokens;
    }
  }
  stats.plannedHunks = batches.reduce((n, b) => n + b.units.reduce((m, u) => m + u.hunks.length, 0), 0);
  return { batches, skipped, stats, estimatedTokens: spent };
}

// Halves a batch for a retry after max_tokens: by units, else by hunks, else
// by the lines of its one hunk. Returns [] when it cannot be made smaller.
export function splitBatch(batch) {
  const mk = (units, n) => ({ ...batch, id: `${batch.id}.${n}`, units, tokens: Math.ceil(batch.tokens / 2), retried: true });
  if (batch.units.length > 1) {
    const mid = Math.ceil(batch.units.length / 2);
    return [mk(batch.units.slice(0, mid), 1), mk(batch.units.slice(mid), 2)];
  }
  const u = batch.units[0];
  if (!u) return [];
  if (u.hunks.length > 1) {
    const mid = Math.ceil(u.hunks.length / 2);
    return [mk([{ ...u, hunks: u.hunks.slice(0, mid), context: [], fileText: null }], 1), mk([{ ...u, hunks: u.hunks.slice(mid), context: [], fileText: null }], 2)];
  }
  const h = u.hunks[0];
  if (!h || h.lines.length < 4) return [];
  const mid = Math.ceil(h.lines.length / 2);
  const half = (lines) => {
    const added = addedOf(lines);
    return { ...h, lines, added, chars: charsOf(lines), newStart: lines.find((l) => l.newLine !== undefined)?.newLine ?? null };
  };
  const a = half(h.lines.slice(0, mid));
  const b = half(h.lines.slice(mid));
  return [a, b].filter((x) => x.added.length).map((x, i) => mk([{ ...u, hunks: [x], context: [], fileText: null }], i + 1));
}
