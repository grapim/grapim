// Applies a page's new Markdown to Notion with as few block changes as it can:
// blocks whose Markdown is unchanged are left alone (so what Markdown cannot
// express, such as colours or comments, survives on them), a changed block
// of the same type is updated in place, new blocks are inserted after the
// block before them, and removed blocks are archived (Notion keeps them in
// its trash). The whole page is never replaced.
//
// Notion's API cannot insert a block before the first block of its parent:
// a new first block is inserted after the old first block, which is then
// re-created below it and archived (its id changes; its content does not).

import { notionId, NotionError } from './client.js';
import { blockMd, CHILD_TYPES, isOpaque, ownMd } from './markdown.js';

const MAX_LCS_CELLS = 4_000_000;
const BATCH = 100; // Notion's limit of blocks per append

// Pairs [i, j] of a longest common subsequence of a and b under eq.
export function lcs(a, b, eq) {
  if (!a.length || !b.length) return [];
  if (a.length * b.length > MAX_LCS_CELLS) {
    // Very long pages: match in order, greedily.
    const out = [];
    let i = 0;
    for (let j = 0; j < b.length && i < a.length; j++) {
      let k = i;
      while (k < a.length && !eq(a[k], b[j])) k++;
      if (k < a.length) {
        out.push([k, j]);
        i = k + 1;
      }
    }
    return out;
  }
  const n = a.length;
  const m = b.length;
  const t = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i][j] = eq(a[i], b[j]) ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const out = [];
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (eq(a[i], b[j])) {
      out.push([i, j]);
      i++;
      j++;
    } else if (t[i + 1][j] >= t[i][j + 1]) i++;
    else j++;
  }
  return out;
}

const sameOpaque = (r, d) => isOpaque(r) && isOpaque(d) && r.type === d.type && !!d.id && notionId(d.id) === notionId(r.id);
// Whether d can be written into r in place.
const compatible = (r, d) => (isOpaque(r) || isOpaque(d) ? sameOpaque(r, d) : r.type === d.type);

const kidsOf = (b) => (!isOpaque(b) && CHILD_TYPES.has(b.type) && Array.isArray(b.children) ? b.children : []);
const deep = (b) => kidsOf(b).some((c) => kidsOf(c).length);

// The body Notion takes to create a block. Children are inlined one level
// deep; deeper ones are appended once their parent exists.
function createBody(b) {
  const type = b.type;
  const payload = JSON.parse(JSON.stringify(b[type] ?? {}));
  delete payload.children;
  if (!isOpaque(b) && kidsOf(b).length && !deep(b)) payload.children = kidsOf(b).map(createBody);
  return { object: 'block', type, [type]: payload };
}

// What PATCH /blocks/{id} takes to give r the content of d.
function updateBody(r, d) {
  if (isOpaque(d)) return { [d.type]: d[d.type] ?? {} };
  const p = d[d.type] ?? {};
  switch (d.type) {
    case 'divider':
      return null;
    case 'to_do':
      return { to_do: { rich_text: p.rich_text ?? [], checked: !!p.checked } };
    case 'code':
      return { code: { rich_text: p.rich_text ?? [], language: p.language ?? 'plain text' } };
    case 'callout': {
      const body = { rich_text: p.rich_text ?? [] };
      const was = r.callout?.icon?.type === 'emoji' ? r.callout.icon.emoji : '';
      const now = p.icon?.type === 'emoji' ? p.icon.emoji : '';
      if (now && now !== was) body.icon = { type: 'emoji', emoji: now };
      return { callout: body };
    }
    default:
      return { [d.type]: { rich_text: p.rich_text ?? [] } };
  }
}

// The blocks an append created, in order. Notion answers with the new
// blocks; if it ever answers with the whole list, they follow the anchor.
function created(results, count, anchor) {
  const r = Array.isArray(results) ? results : [];
  if (r.length === count) return r;
  const at = anchor ? r.findIndex((b) => notionId(b.id) === notionId(anchor)) : -1;
  return at >= 0 ? r.slice(at + 1, at + 1 + count) : r.slice(-count);
}

// Makes the children of parentId (now `remote`, as fetched) match `desired`.
// ops counts what was done: { updated, added, archived }.
export async function syncChildren(client, parentId, remote, desired, ops) {
  const rs = remote.map(blockMd);
  const ds = desired.map(blockMd);
  const plan = new Array(desired.length).fill(null);
  const used = new Set();
  const anchors = lcs(
    remote.map((_, i) => i),
    desired.map((_, j) => j),
    (i, j) => rs[i] === ds[j],
  );
  for (const [i, j] of anchors) {
    plan[j] = { kind: 'keep', r: remote[i] };
    used.add(i);
  }
  // Between two unchanged blocks: same-type blocks are updated in place.
  const bounds = [[-1, -1], ...anchors, [remote.length, desired.length]];
  for (let k = 0; k + 1 < bounds.length; k++) {
    const [i0, j0] = bounds[k];
    const [i1, j1] = bounds[k + 1];
    const R = remote.slice(i0 + 1, i1);
    const D = desired.slice(j0 + 1, j1);
    for (const [i, j] of lcs(R, D, compatible)) {
      plan[j0 + 1 + j] = { kind: 'update', r: R[i] };
      used.add(i0 + 1 + i);
    }
  }
  for (let j = 0; j < plan.length; j++) plan[j] ??= { kind: 'new' };
  const archive = remote.filter((_, i) => !used.has(i));

  let anchor = null;
  const first = plan.findIndex((p) => p.kind !== 'new');
  if (first > 0) {
    // New blocks before the first kept one: insert after it, re-create it below them.
    const k = plan[first].r;
    if (isOpaque(k)) {
      throw new NotionError(409, 'cannot_insert', `Notion's API cannot insert blocks above the first block of a page or list when that block is a ${k.type.replace(/_/g, ' ')}. Add the new blocks below it.`);
    }
    anchor = k.id;
    archive.unshift(k);
    plan[first] = { kind: 'new' };
  }

  let batch = [];
  const flush = async () => {
    for (let s = 0; s < batch.length; s += BATCH) {
      const part = batch.slice(s, s + BATCH);
      const r = await client.append(parentId, part.map(createBody), anchor);
      const made = created(r?.results, part.length, anchor);
      ops.added += part.length;
      for (let x = 0; x < part.length; x++) {
        if (deep(part[x]) && made[x]?.id) await syncChildren(client, made[x].id, [], kidsOf(part[x]), ops);
      }
      if (made.length) anchor = made.at(-1).id;
    }
    batch = [];
  };
  for (let j = 0; j < desired.length; j++) {
    const p = plan[j];
    if (p.kind === 'new') {
      batch.push(desired[j]);
      continue;
    }
    await flush();
    if (p.kind === 'update') await updateBlock(client, p.r, desired[j], ops);
    anchor = p.r.id;
  }
  await flush();
  for (const r of archive) {
    await client.deleteBlock(r.id);
    ops.archived++;
  }
}

async function updateBlock(client, r, d, ops) {
  if (ownMd(r) !== ownMd(d)) {
    const body = updateBody(r, d);
    if (body) {
      await client.updateBlock(r.id, body);
      ops.updated++;
    }
  }
  if (isOpaque(r) || !CHILD_TYPES.has(r.type)) return;
  const rk = kidsOf(r);
  const dk = kidsOf(d);
  if (rk.map(blockMd).join('\n\u0000') !== dk.map(blockMd).join('\n\u0000')) await syncChildren(client, r.id, rk, dk, ops);
}
