// Storage keys are plain relative names like "ws/team/abc/blobs/<sha>".
// Both backends refuse anything outside this pattern, so no key can climb out
// of the local folder or the bucket prefix.

const KEY_CHARS = /^[A-Za-z0-9._/-]+$/;
const MAX_KEY = 1024;

export class StorageKeyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StorageKeyError';
    this.code = 'invalid_key';
    this.retryable = false;
  }
}

// Shown in errors without echoing arbitrary bytes back.
const show = (k) => JSON.stringify(String(k).slice(0, 120));

function checkShape(key, what) {
  if (typeof key !== 'string') throw new StorageKeyError(`${what} must be a string`);
  if (key.length > MAX_KEY) throw new StorageKeyError(`${what} is longer than ${MAX_KEY} characters`);
  if (key.includes('\\')) throw new StorageKeyError(`${what} ${show(key)} contains a backslash`);
  if (key.startsWith('/')) throw new StorageKeyError(`${what} ${show(key)} starts with /`);
  if (key.includes('..')) throw new StorageKeyError(`${what} ${show(key)} contains ..`);
  if (key.includes('//')) throw new StorageKeyError(`${what} ${show(key)} has an empty segment`);
  if (key.split('/').includes('.')) throw new StorageKeyError(`${what} ${show(key)} has a . segment`);
}

// A full object key: non-empty, no trailing slash.
export function validateKey(key) {
  checkShape(key, 'storage key');
  if (!KEY_CHARS.test(key)) throw new StorageKeyError(`storage key ${show(key)} has characters outside [A-Za-z0-9._/-]`);
  if (key.endsWith('/')) throw new StorageKeyError(`storage key ${show(key)} ends with /`);
  return key;
}

export function isValidKey(key) {
  try {
    validateKey(key);
    return true;
  } catch {
    return false;
  }
}

// A list prefix: may be empty, may end with "/" or stop mid-name.
export function validatePrefix(prefix = '') {
  if (prefix === '') return prefix;
  checkShape(prefix, 'storage prefix');
  if (!KEY_CHARS.test(prefix)) throw new StorageKeyError(`storage prefix ${show(prefix)} has characters outside [A-Za-z0-9._/-]`);
  return prefix;
}
