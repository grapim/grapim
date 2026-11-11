// file:///abs/dir: objects are plain files under one folder.
// Writes go to a random temp file opened with 'wx', then rename over the target,
// so a reader never sees half an object. Temp names carry a "~", which no valid
// key can contain, so list() never returns one.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidKey, validateKey, validatePrefix } from './keys.js';

export function localDirFromUrl(url) {
  let dir;
  try {
    dir = fileURLToPath(new URL(url));
  } catch {
    // Tolerate "file://C:\data\storage" built by string concatenation on Windows.
    dir = decodeURIComponent(String(url).replace(/^file:\/\//, ''));
  }
  if (!path.isAbsolute(dir)) throw new Error(`storage url must name an absolute folder (file:///abs/dir), got ${url}`);
  return path.resolve(dir);
}

const RENAME_RETRIES = 5;

async function renameWithRetry(from, to) {
  // On Windows a rename onto a file someone is reading can fail briefly.
  for (let i = 0; ; i++) {
    try {
      return await fs.rename(from, to);
    } catch (err) {
      if (i >= RENAME_RETRIES || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err;
      await new Promise((r) => setTimeout(r, 20 * (i + 1)));
    }
  }
}

export async function writeFileAtomic(target, buf) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}~${crypto.randomBytes(8).toString('hex')}.tmp`;
  const fh = await fs.open(tmp, 'wx');
  try {
    await fh.writeFile(buf);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await renameWithRetry(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export function createLocalStorage(url) {
  const root = localDirFromUrl(url);

  const fileOf = (key) => {
    validateKey(key);
    const abs = path.resolve(root, ...key.split('/'));
    // Belt and braces: the key pattern already forbids traversal.
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('storage key resolves outside the storage folder');
    return abs;
  };

  async function walk(dirAbs, relPrefix, out) {
    let entries;
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return;
      throw err;
    }
    for (const e of entries) {
      const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
      // Symlinks are neither files nor dirs here, so they are never followed.
      if (e.isDirectory()) await walk(path.join(dirAbs, e.name), rel, out);
      else if (e.isFile()) out.push(rel);
    }
  }

  return {
    kind: 'file',
    describe: () => `file://${root}`,

    async put(key, buf) {
      await writeFileAtomic(fileOf(key), Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    },

    async get(key) {
      try {
        return await fs.readFile(fileOf(key));
      } catch (err) {
        if (err.code === 'ENOENT' || err.code === 'ENOTDIR' || err.code === 'EISDIR') return null;
        throw err;
      }
    },

    async has(key) {
      try {
        return (await fs.stat(fileOf(key))).isFile();
      } catch (err) {
        if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return false;
        throw err;
      }
    },

    async delete(key) {
      const abs = fileOf(key);
      try {
        await fs.unlink(abs);
      } catch (err) {
        if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
      }
    },

    async list(prefix = '') {
      validatePrefix(prefix);
      // Start at the deepest folder the prefix names, then filter by the rest.
      const cut = prefix.lastIndexOf('/');
      const dirRel = cut === -1 ? '' : prefix.slice(0, cut);
      const start = dirRel ? path.join(root, ...dirRel.split('/')) : root;
      const out = [];
      await walk(start, dirRel, out);
      return out
        .filter((k) => k.startsWith(prefix) && isValidKey(k))
        .sort();
    },
  };
}
