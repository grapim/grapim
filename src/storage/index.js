// Pluggable object storage for Grapim (docs/workspaces.md section 4).
//
//   const storage = createStorage(process.env.HUB_STORAGE_URL || defaultStorageUrl());
//   await storage.put(key, buf); await storage.get(key);   // Buffer | null
//   await storage.has(key); await storage.delete(key); await storage.list(prefix);
//
// file:///abs/dir                                     local folder
// s3://bucket/prefix?endpoint=https://...&region=...   AWS S3, Cloudflare R2, MinIO
// gs://bucket/prefix                                   Google Cloud Storage (XML API, HMAC key)
// azure://account/container/prefix                     Azure Blob Storage (Shared Key)

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAzureStorage } from './azure.js';
import { createLocalStorage } from './local.js';
import { createGcsStorage, createS3Storage } from './s3.js';

export { validateKey, validatePrefix, isValidKey, StorageKeyError } from './keys.js';

// `opts` is for tests and tuning: { fetch, retry, timeoutMs, pageSize } (remote stores only).
export function createStorage(url, env = process.env, opts = {}) {
  if (typeof url !== 'string' || !url) throw new Error('storage url is empty');
  const scheme = url.slice(0, url.indexOf(':') + 1).toLowerCase();
  if (scheme === 'file:') return createLocalStorage(url);
  if (scheme === 's3:') return createS3Storage(url, env, opts);
  if (scheme === 'gs:') return createGcsStorage(url, env, opts);
  if (scheme === 'azure:') return createAzureStorage(url, env, opts);
  throw new Error(`unsupported storage url scheme ${JSON.stringify(scheme || url.slice(0, 10))}; use file://, s3://, gs:// or azure://`);
}

// file://${HUB_DATA}/storage, built so it is also valid on Windows.
export function defaultStorageUrl(env = process.env) {
  const data = env.HUB_DATA || path.resolve('data');
  return pathToFileURL(path.join(path.resolve(data), 'storage')).href;
}
