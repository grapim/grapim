// Keeps one connector and one workspace in step, both ways, through the same
// ledger as every other change (docs/connectors.md):
//
// - pull: what changed remotely is written under saas/<name>/ as the run
//   saas:<name> (labelled with the connector's title, one turn per pull,
//   approved automatically, like sync), so the history shows what changed in
//   the SaaS, and blame and undo work on it.
// - afterWrite: an agent's write (/fs, MCP, WebDAV), an undo or a restore of a
//   mapped file is pushed: the connector applies it remotely if the remote
//   item is still at the version last synced; if not, the three sides are
//   merged (mergeFile, as folder sync does). A clean merge is written back
//   and pushed; a conflict leaves the remote version at the path, the
//   agent's version in a conflict copy beside it, and pushes nothing. What
//   happened comes back in the write's response.
//
// The connector never writes outside saas/<name>/: every path it names is
// checked here, then by resolvePath and the sensitive-file guard like any
// agent's. Its writes skip a file another agent holds or is editing (they
// are tried again at the next pull), except the agent whose write is being
// pushed.
//
// h, the workspace handle: { store, ws, offload?, admit?(bytes), wrote?() }.

import { mergeFile, writeFile, leavesRoot } from '../undo.js';
import { countLines, detailOf, sha1, snapshot } from '../ledger.js';
import { autoApprove } from '../review.js';
import { guardSensitiveWrite, resolvePath } from '../server/paths.js';
import { rootKey } from '../workspace.js';
import { conflictName } from '../folder-sync.js';
import { openState } from './state.js';

export const SAAS_ROOT = 'saas';
const NAME_RE = /^[a-z][a-z0-9-]{0,30}$/;

export class PathRefused extends Error {
  constructor(message) {
    super(message);
    this.code = 'forbidden';
  }
}

// Whether rel is a file the connector `name` may write: saas/<name>/<file>.md, flat.
export function connectorPath(name, rel) {
  const root = `${SAAS_ROOT}/${name}/`;
  if (typeof rel !== 'string' || !rel.startsWith(root)) return false;
  const leaf = rel.slice(root.length);
  return !!leaf && leaf.length <= 200 && !/[/\\\x00-\x1f\x7f]/.test(leaf) && leaf !== '.' && leaf !== '..' && leaf.endsWith('.md');
}

export function checkPath(name, rel) {
  if (!connectorPath(name, rel)) throw new PathRefused(`The ${name} connector may only write files directly in ${SAAS_ROOT}/${name}/ (refused "${String(rel).slice(0, 200)}").`);
  return rel;
}

const fileSafe = (s) => String(s ?? 'agent').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 40) || 'agent';
const today = (now) => new Date(now()).toISOString().slice(0, 10);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function opsText(ops, title) {
  const parts = [];
  if (ops.updated) parts.push(`${plural(ops.updated, 'block')} updated`);
  if (ops.added) parts.push(`${plural(ops.added, 'block')} added`);
  if (ops.archived) parts.push(`${plural(ops.archived, 'block')} archived`);
  if (ops.properties?.length) parts.push(`${plural(ops.properties.length, 'property')} changed (${ops.properties.join(', ')})`);
  const done = parts.length ? `Applied to ${title}: ${parts.join(', ')}.` : `${title} already had this content.`;
  return ops.ignored?.length ? `${done} Not written: ${ops.ignored.join('; ')}.` : done;
}

// How long an agent's write waits for a pull in progress before it answers
// without the push's result. The push still runs when the pull is done.
export const PUSH_WAIT_MS = 20_000;

// connector: see src/connectors/index.js. log(line), now(). waitMs: PUSH_WAIT_MS.
export function createSync({ connector, log = () => {}, now = () => Date.now(), waitMs = PUSH_WAIT_MS }) {
  const d = connector.describe();
  if (!NAME_RE.test(d.name)) throw new Error(`bad connector name ${d.name}`);
  const name = d.name;
  const title = d.title;
  const run = `saas:${name}`;
  let chain = Promise.resolve();
  // One pull or push at a time per workspace and connector.
  const locked = (fn) => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  };

  const stateOf = (h) => openState(h.ws.stateDir, name);

  // ---- writes into the workspace, as saas:<name> ----

  function turnOf(h, ctx) {
    if (ctx.turned) return;
    ctx.turned = true;
    h.store.setIntent(run, `Changes from ${title}`, { label: title, worktree: h.ws.worktree });
    h.store.nextTurn(run);
  }

  // Writes buf (null deletes) at rel. Returns { path, sha } or { skipped }.
  async function put(h, ctx, rel, buf, { allow = null } = {}) {
    checkPath(name, rel);
    guardSensitiveWrite(h.ws, rel, {});
    const t = resolvePath(h.ws, rel);
    guardSensitiveWrite(h.ws, rel, {}, t.abs);
    const held = h.store.holder(t.file.key, allow ?? run);
    if (held && held.agent !== run) return { skipped: `${t.rel} is held by ${held.label || held.agent}` };
    const p = h.store.editInProgress(rootKey(h.ws.root), t.file.key);
    if (p && p.run !== allow && p.run !== run) return { skipped: `${p.label || p.run} is editing ${t.rel}` };
    if (leavesRoot(h.ws.root, t.abs)) throw new PathRefused(`A folder on the path of ${t.rel} leads outside the workspace.`);
    const before = snapshot(t.abs);
    const sha = buf === null ? null : sha1(buf);
    if (before.sha === sha) return { path: t.rel, sha, same: true };
    if (buf !== null) await h.admit?.(buf.length);
    if (h.offload && (before.sha === null || before.buf) && buf) await h.offload.prepare([[before.buf, buf]]).catch(() => {});
    // Nothing awaited from here to the record: no request interleaves.
    if (snapshot(t.abs).sha !== before.sha) return { skipped: `${t.rel} changed while ${title} was writing it` };
    turnOf(h, ctx);
    writeFile(t.abs, { sha, buf });
    const after = snapshot(t.abs);
    const untracked = (before.sha !== null && !before.buf) || (after.sha !== null && !after.buf);
    const stats = untracked ? { untracked: true } : { untracked: false, ...countLines(h.store, before.buf, after.buf) };
    h.store.recordChange({ root: h.ws.root, root_key: rootKey(h.ws.root), path_key: t.file.key, path: t.rel, run, label: title, turn: h.store.turn(run), ...stats }, before, after);
    h.store.recordEdit(run, t.rel, detailOf(stats));
    ctx.changed++;
    return { path: t.rel, sha: after.sha };
  }

  const finish = (h, ctx) => {
    if (!ctx.changed) return;
    autoApprove(h.store, run, run);
    h.wrote?.();
  };

  // A free name for a conflict copy of rel.
  function copyPath(h, rel, by) {
    for (let n = 1; n < 100; n++) {
      const c = conflictName(rel, fileSafe(by), today(now), n);
      if (!connectorPath(name, c)) break;
      if (snapshot(resolvePath(h.ws, c).abs).sha === null) return c;
    }
    return null;
  }

  // ---- push ----

  // Sends buf (the file now) for a mapped entry. by: the run whose write it is.
  async function pushEntry(h, st, ctx, entry, buf, by) {
    try {
      let r = await connector.push(entry, buf.toString('utf8'), entry.version);
      if (!r.conflict) {
        Object.assign(entry, { version: r.version, sha: sha1(buf), base: st.putBase(r.remote), dirty: false });
        st.set(entry);
        return { status: 'pushed', ops: r.ops, message: opsText(r.ops, title) };
      }
      // Changed remotely since the base: merge the three sides.
      const base = st.base(entry.base);
      const remote = Buffer.from(r.remote, 'utf8');
      const m = base === null ? { clean: false } : mergeFile(buf, Buffer.from(base, 'utf8'), remote);
      if (m.clean) {
        // The merge goes into the file first, so it is never lost; then remotely.
        const merged = m.buf;
        const w = await put(h, ctx, entry.path, merged, { allow: by });
        if (w.skipped) {
          entry.dirty = true;
          st.set(entry);
          return { status: 'error', message: `${title} had changed this page, and the merge could not be written here (${w.skipped}). Nothing was sent; Grapim tries again at the next sync.` };
        }
        Object.assign(entry, { version: r.version, base: st.putBase(r.remote), sha: sha1(merged), dirty: true });
        st.set(entry);
        const r2 = merged.equals(remote) ? { version: r.version, remote: r.remote, ops: { updated: 0, added: 0, archived: 0 } } : await connector.push(entry, merged.toString('utf8'), r.version);
        if (!r2.conflict) {
          Object.assign(entry, { version: r2.version, base: st.putBase(r2.remote), dirty: false });
          st.set(entry);
          return { status: 'merged', sha: sha1(merged), ops: r2.ops, message: `${title} had changed this page since it was last synced. Your edit was merged with those changes and applied. ${opsText(r2.ops, title)} Read the file again before your next edit.` };
        }
        // It changed again in between: the merge is what we keep aside.
        r = r2;
        buf = merged;
      }
      // A conflict: the remote version at the path, the agent's beside it.
      const remoteNow = Buffer.from(r.remote, 'utf8');
      const copy = copyPath(h, entry.path, ctx.who ?? by);
      const c = copy ? await put(h, ctx, copy, buf, { allow: by }) : { skipped: 'no free name' };
      if (c.skipped) {
        entry.dirty = true;
        st.set(entry);
        return { status: 'conflict', message: `${title} changed this page since it was last synced, and your edit overlaps those changes. Nothing was sent to ${title}, and your version could not be copied aside (${c.skipped}).` };
      }
      const w = await put(h, ctx, entry.path, remoteNow, { allow: by });
      if (w.skipped) {
        entry.dirty = true;
        st.set(entry);
        return { status: 'conflict', copy, message: `${title} changed this page since it was last synced, and your edit overlaps those changes. Nothing was sent to ${title}. Your version is also in ${copy}; ${title}'s version could not be written yet (${w.skipped}).` };
      }
      Object.assign(entry, { version: r.version, sha: sha1(remoteNow), base: st.putBase(r.remote), dirty: false });
      st.set(entry);
      return {
        status: 'conflict',
        copy,
        sha: sha1(remoteNow),
        message: `${title} changed this page since it was last synced, and your edit overlaps those changes. Nothing was sent to ${title}. ${entry.path} now has ${title}'s version; yours is in ${copy}. Merge the two into ${entry.path} and write it again.`,
      };
    } catch (err) {
      if (err instanceof PathRefused) throw err;
      entry.dirty = true;
      st.set(entry);
      log(`${name}: push failed: ${err?.message ?? err}`);
      return { status: 'error', message: `Not sent to ${title}: ${err?.message ?? 'unknown error'} The file keeps your version; Grapim tries again at the next sync.` };
    }
  }

  // The file was deleted: the remote item goes to the trash.
  async function removeEntry(st, entry) {
    try {
      await connector.remove(entry);
    } catch (err) {
      entry.dirty = true;
      st.set(entry);
      return { status: 'error', message: `Not sent to ${title}: ${err?.message ?? 'unknown error'} Grapim tries again at the next sync.` };
    }
    Object.assign(entry, { deleted: true, sha: null, dirty: false });
    st.set(entry);
    return { status: 'archived', message: `The page was moved to ${title}'s trash. Undoing this delete brings it back.` };
  }

  async function afterWrite(h, event) {
    if (!connectorPath(name, event?.path) || String(event.run ?? '').startsWith('saas:')) return null;
    const ctx = { changed: 0, who: event.label || event.run };
    try {
      const st = stateOf(h);
      const entry = st.byPath(event.path);
      if (!entry) {
        return { connector: name, status: 'not_linked', message: `${event.path} is not linked to a ${title} page, so it was not sent to ${title}. Only pages pulled from ${title} are written back.` };
      }
      const t = resolvePath(h.ws, entry.path);
      const local = snapshot(t.abs);
      let out;
      if (local.sha === entry.sha && !entry.dirty) out = { status: 'unchanged', message: `${title} already has this version.` };
      else if (local.sha === null) out = await removeEntry(st, entry);
      else if (!local.buf) {
        out = { status: 'error', message: `Not sent to ${title}: the file is binary or over 2 MB.` };
      } else {
        if (entry.deleted) {
          await connector.restore(entry);
          entry.deleted = false;
        }
        out = await pushEntry(h, st, ctx, entry, local.buf, event.run);
      }
      st.save();
      finish(h, ctx);
      return { connector: name, ...out };
    } catch (err) {
      finish(h, ctx);
      if (err instanceof PathRefused) return { connector: name, status: 'error', message: err.message };
      log(`${name}: ${err?.message ?? err}`);
      return { connector: name, status: 'error', message: `Not sent to ${title}: ${err?.message ?? 'unknown error'}` };
    }
  }

  // ---- pull ----

  // A path for a new item: the connector's, or its long form if that is taken.
  function freePath(h, st, item) {
    for (const p of [item.path, item.longPath].filter(Boolean)) {
      checkPath(name, p);
      const other = st.byPath(p);
      if (other && other.id !== item.id) continue;
      return p;
    }
    throw new PathRefused(`No free file name for ${item.id}.`);
  }

  async function pullItem(h, st, ctx, item, summary) {
    let entry = st.byId(item.id);
    if (entry && entry.version === item.version && !entry.deleted) {
      entry.edited = item.edited;
      return;
    }
    const rel = checkPath(name, entry?.path ?? freePath(h, st, item));
    const buf = Buffer.from(item.content, 'utf8');
    const local = snapshot(resolvePath(h.ws, rel).abs);
    const keep = (w, extra = {}) => {
      if (w.skipped) {
        summary.skipped.push(w.skipped);
        return false;
      }
      st.set({ ...(entry ?? {}), id: item.id, path: rel, version: item.version, sha: w.sha, base: st.putBase(item.content), edited: item.edited, deleted: false, dirty: false, ...extra });
      return true;
    };
    if (!entry || entry.deleted) {
      if (local.sha === null || local.sha === sha1(buf)) {
        const w = await put(h, ctx, rel, buf);
        if (keep(w) && !w.same) summary.created++;
        return;
      }
      // A file we do not know is in the way: keep it as a conflict copy.
      const copy = copyPath(h, rel, 'workspace');
      if (copy && local.buf) {
        const c = await put(h, ctx, copy, local.buf);
        if (c.skipped) return void summary.skipped.push(c.skipped);
      } else return void summary.skipped.push(`${rel} is in the way`);
      if (keep(await put(h, ctx, rel, buf))) summary.created++;
      return;
    }
    // Unchanged here since the last sync (and nothing waiting to be pushed): take Notion's.
    if ((local.sha === entry.sha && !entry.dirty) || local.sha === sha1(buf)) {
      const w = await put(h, ctx, rel, buf);
      if (keep(w) && !w.same) summary.updated++;
      return;
    }
    if (local.sha === null) {
      // Deleted here but the push did not go through: the remote change wins back.
      if (keep(await put(h, ctx, rel, buf))) summary.updated++;
      return;
    }
    // Changed on both sides (a push that failed): merge, then push the result.
    // The mapping moves to the new remote version only once the merge is written.
    const base = st.base(entry.base);
    const m = base === null || !local.buf ? { clean: false } : mergeFile(local.buf, Buffer.from(base, 'utf8'), buf);
    if (m.clean) {
      const w = await put(h, ctx, rel, m.buf);
      if (w.skipped) return void summary.skipped.push(w.skipped);
      entry = st.set({ ...entry, version: item.version, sha: w.sha, base: st.putBase(item.content), dirty: true });
      const r = await pushEntry(h, st, ctx, entry, m.buf, run);
      summary.merged++;
      if (r.status === 'error') summary.errors.push(r.message);
      return;
    }
    const copy = copyPath(h, rel, 'workspace');
    const c = copy && local.buf ? await put(h, ctx, copy, local.buf) : { skipped: `${rel}: no conflict copy` };
    if (c.skipped) return void summary.skipped.push(c.skipped);
    if (keep(await put(h, ctx, rel, buf))) summary.conflicts.push(copy);
  }

  async function pull(h) {
    const st = stateOf(h);
    const ctx = { changed: 0 };
    const summary = { pages: 0, created: 0, updated: 0, deleted: 0, merged: 0, conflicts: [], skipped: [], errors: [] };
    try {
      const r = await connector.pull(st.cursor);
      summary.pages = r.present ? r.present.size : st.items().filter((e) => !e.deleted).length;
      // Items the connector could not read: this pull's errors, the others go on.
      for (const e of r.errors ?? []) summary.errors.push(String(e));
      for (const item of r.items) {
        try {
          await pullItem(h, st, ctx, item, summary);
        } catch (err) {
          summary.errors.push(`${item.title || item.id}: ${err?.message ?? err}`);
        }
      }
      // Pushes that failed earlier, for items that did not change remotely.
      const fresh = new Set(r.items.map((i) => i.id));
      for (const e of st.items()) {
        if (!e.dirty || e.deleted || fresh.has(e.id)) continue;
        const local = snapshot(resolvePath(h.ws, e.path).abs);
        if (local.sha !== null && !local.buf) continue;
        const out = local.sha === null ? await removeEntry(st, e) : await pushEntry(h, st, ctx, e, local.buf, run);
        if (out.status === 'error') summary.errors.push(out.message);
      }
      // Items no longer in scope (unshared, or in Notion's trash).
      if (r.present) {
        const gone = st.items().filter((e) => !e.deleted && !r.present.has(e.id));
        if (gone.length && r.present.size === 0) summary.errors.push(`${title} returned no pages at all, so no files were removed. Check that the integration is still connected to the pages.`);
        else {
          for (const e of gone) {
            const local = snapshot(resolvePath(h.ws, e.path).abs);
            if (local.sha !== null && local.sha === e.sha) {
              const w = await put(h, ctx, e.path, null);
              if (w.skipped) {
                summary.skipped.push(w.skipped);
                continue;
              }
              summary.deleted++;
            }
            st.drop(e.id);
          }
        }
      }
      if (!r.present) summary.pages = st.items().filter((e) => !e.deleted).length;
      if (!summary.errors.length) st.cursor = r.cursor;
      st.save();
      st.prune();
      return summary;
    } finally {
      finish(h, ctx);
    }
  }

  return {
    name,
    title,
    run,
    describe: () => d,
    pull: (h) => locked(() => pull(h)),
    // A pull of a big workspace holds the lock for minutes: the agent's write
    // must not hang (and hold its upload slot) that long (security review
    // batch 5, M5). After waitMs it answers "queued"; the push still runs in
    // its turn, with the file as it is then.
    afterWrite: (h, event) => {
      if (!connectorPath(name, event?.path)) return Promise.resolve(null);
      const work = locked(() => afterWrite(h, event));
      work.catch(() => {}); // answered by then, or never rejects (afterWrite catches)
      let timer;
      const late = new Promise((resolve) => {
        timer = setTimeout(
          () => resolve({ connector: name, status: 'queued', message: `${title} is being synced right now, so this edit was not sent yet. It is sent as soon as that sync ends; read the file again before your next edit.` }),
          waitMs,
        );
        timer.unref?.();
      });
      return Promise.race([work, late]).finally(() => clearTimeout(timer));
    },
    // Linked items, for the hub page.
    count: (h) => stateOf(h).items().filter((e) => !e.deleted).length,
  };
}
