// Pluggable object storage for Grapim (docs/workspaces.md section 4).
//
//   const storage = createStorage(process.env.HUB_STORAGE_URL || defaultStorageUrl());
//   await storage.put(key, buf); await storage.get(key);   // Buffer | null
//   await storage.has(key); await storage.delete(key); await storage.list(prefix);
//
// file:///abs/dir                                     local folder
// s3://bucket/prefix?endpoint=https://...&region=...   AWS S3, Cloudflare R2, MinIO

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLocalStorage } from './local.js';
import { createS3Storage } from './s3.js';

export { validateKey, validatePrefix, isValidKey, StorageKeyError } from './keys.js';

// `opts` is for tests and tuning: { fetch, retry, timeoutMs, pageSize } (S3 only).
export function createStorage(url, env = process.env, opts = {}) {
  if (typeof url !== 'string' || !url) throw new Error('storage url is empty');
  const scheme = url.slice(0, url.indexOf(':') + 1).toLowerCase();
  if (scheme === 'file:') return createLocalStorage(url);
  if (scheme === 's3:') return createS3Storage(url, env, opts);
  throw new Error(`unsupported storage url scheme ${JSON.stringify(scheme || url.slice(0, 10))}; use file:// or s3://`);
}

// file://${HUB_DATA}/storage, built so it is also valid on Windows.
export function defaultStorageUrl(env = process.env) {
  const data = env.HUB_DATA || path.resolve('data');
  return pathToFileURL(path.join(path.resolve(data), 'storage')).href;
}
