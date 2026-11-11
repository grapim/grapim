// The engine's post-write callback (createEngine({ afterWrite })), for the
// hub's SaaS connectors (src/connectors/): after every recorded write or
// delete of a file, by /fs, MCP, WebDAV, an undo or a restore, the engine
// calls
//
//   afterWrite({ path, run, label, sha, kind }) -> Promise<object | null>
//
// kind: 'write' | 'delete' | 'undo' | 'restore'. Whatever it returns is
// added to that write's response as `saas` (a write whose file the callback
// then changed, such as a merge, also gets the file's new `sha`). It must
// not throw; a callback error is reported in `saas`, never as a failed write
// (the write itself is already recorded).

async function call(afterWrite, event) {
  try {
    return (await afterWrite(event)) ?? null;
  } catch (err) {
    return { status: 'error', message: `The write was recorded, but sending it on failed: ${err?.message ?? err}` };
  }
}

// The workspace (src/server/fs.js) with write and remove followed by the callback.
export function withAfterWrite(workspace, afterWrite) {
  if (!afterWrite) return workspace;
  const after = async (me, r, kind) => {
    const saas = await call(afterWrite, { path: r.path, run: me.agent, label: me.label ?? null, sha: r.sha ?? null, kind });
    if (!saas) return r;
    return { ...r, ...(typeof saas.sha === 'string' ? { sha: saas.sha } : {}), saas };
  };
  return {
    ...workspace,
    write: async (me, rel, buf, opts) => after(me, await workspace.write(me, rel, buf, opts), 'write'),
    remove: async (me, rel, opts) => after(me, await workspace.remove(me, rel, opts), 'delete'),
  };
}

// After an undo or a restore: the callback for each file it changed. Returns
// [{ path, ...result }] for the ones the callback answered, or null.
export async function afterWrites(afterWrite, files, { run, kind }) {
  if (!afterWrite) return null;
  const out = [];
  for (const f of files) {
    const saas = await call(afterWrite, { path: f.path, run, label: null, sha: f.sha ?? null, kind });
    if (saas) out.push({ path: f.path, ...saas });
  }
  return out.length ? out : null;
}
