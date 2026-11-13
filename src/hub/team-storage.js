// A team's own bucket for its workspace files (docs/storage.md, "客戶自己的
// bucket"; docs/workspaces.md section 4). Owner only.
//
// - Config: provider (s3, r2, gcs, azure), bucket or container, prefix,
//   endpoint, region (S3), account (Azure). Stored in team_storage.config as
//   JSON (no secrets), the storage url mirrored into teams.storage_url.
// - Credentials: AES-256-GCM (src/hub/platform/util.js sealer) bound to the
//   column and the team id ("team_storage.credentials\n<team_id>"), so a
//   value copied into another team's row, or into the other column, does not
//   open. Never shown again, never logged, never in an error.
// - Before saving: the endpoint is vetted like a webhook URL (https, public
//   addresses only after DNS, no redirects; src/hub/platform/ssrf.js), then a
//   probe puts, reads back, lists and deletes a random key.
// - A move: a background job copies the team's blobs and manifests from the
//   store in use to the new one (resumable from a cursor, idempotent, with
//   progress), then verifies, and only then switches. Meanwhile writes go to
//   both (the old store first: it stays authoritative), blob reads try the
//   new store and fall back to the old one, and manifests (the only objects
//   that change) are read from the old one. Moving back to the hub's store
//   works the same way.
//
// Every request to a team's bucket goes through safeFetch below: the
// endpoint's addresses are checked after DNS resolution and the connection is
// pinned to the checked address.

import crypto from 'node:crypto';
import https from 'node:https';
import net from 'node:net';
import { HttpError, redirect } from './http.js';
import { defaultResolve, parseWebhookUrl, UrlRefused, vet } from './platform/ssrf.js';
import { sealer as makeSealer } from './platform/util.js';
import { storageSection } from './pages/storage.js';

export const PROVIDERS = Object.freeze({ s3: 'Amazon S3', r2: 'Cloudflare R2', gcs: 'Google Cloud Storage', azure: 'Azure Blob Storage' });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS team_storage (
  team_id          TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
  config           TEXT,              -- JSON, no secrets; NULL: the hub's own store
  credentials      TEXT,              -- sealed, bound to (column, team)
  saved_at         INTEGER,
  saved_by         TEXT,
  move_state       TEXT CHECK (move_state IN ('copying', 'failed')),
  move_config      TEXT,              -- the store moved to; NULL with a move_state: the hub's own
  move_credentials TEXT,              -- sealed, bound to (column, team)
  move_pass        INTEGER NOT NULL DEFAULT 0,
  move_cursor      TEXT,              -- last key done in this pass
  move_done        INTEGER NOT NULL DEFAULT 0,
  move_total       INTEGER NOT NULL DEFAULT 0,
  move_copied      INTEGER NOT NULL DEFAULT 0,
  move_error       TEXT,
  move_started_at  INTEGER,
  move_updated_at  INTEGER,
  move_by          TEXT
);
`;

const TEAM_KEY = /^ws\/([A-Za-z0-9_-]{6,40})\//;
const BLOB_KEY = /\/blobs\/([0-9a-f]{40})$/;
const MAX_PASSES = 6;
const VET_TTL_MS = 60_000;
// A customer endpoint is untrusted: cap one reply well above the largest
// object we store (32 MB files, manifests) but far below what could exhaust memory.
const MAX_REPLY = 64 * 1024 * 1024;
const PRINTABLE = /^[\x21-\x7e]{1,256}$/;
const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

const bad = (message) => new HttpError(400, 'invalid_storage', message);

// ------------------------------------------------------------- config ----

const fieldOf = (input, name) => {
  const v = input?.[name];
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw bad(`${name} must be a string.`);
  return v.trim();
};

// An https origin on a public-looking host, or a 400. The addresses are
// checked separately, after DNS (vetEndpoint), and on every request.
function cleanEndpoint(raw) {
  if (!raw) return null;
  if (raw.length > 300) throw bad('endpoint is too long.');
  let u;
  try {
    ({ url: u } = parseWebhookUrl(raw));
  } catch (err) {
    if (err instanceof UrlRefused) throw bad(err.code === 'url_invalid' ? 'endpoint is not a valid URL.' : 'endpoint must be https on a public host name or address (no localhost, private, link-local or metadata addresses, no user name or password).');
    throw err;
  }
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash) throw bad('endpoint is a bare origin like https://s3.example.com, without a path or query.');
  return u.origin;
}

// The non-secret config of a store, checked, plus the url createStorage takes.
export function normalizeConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('storage is an object with provider, bucket, prefix, endpoint and credentials.');
  const provider = fieldOf(input, 'provider').toLowerCase();
  if (!PROVIDERS[provider]) throw bad('provider is one of s3, r2, gcs, azure.');
  const bucket = fieldOf(input, 'bucket');
  let prefix = fieldOf(input, 'prefix').replace(/^\/+|\/+$/g, '');
  if (prefix.length > 200 || (prefix && (!/^[A-Za-z0-9._/-]+$/.test(prefix) || prefix.includes('..') || prefix.includes('//') || prefix.split('/').includes('.')))) {
    throw bad('prefix is up to 200 characters of letters, digits, ".", "_", "-" and "/", with no empty, "." or ".." part.');
  }
  let endpoint = cleanEndpoint(fieldOf(input, 'endpoint'));
  let region = fieldOf(input, 'region').toLowerCase();
  let account = fieldOf(input, 'account').toLowerCase();
  const pfx = prefix ? `/${prefix}` : '';
  let url;
  if (provider === 'azure') {
    if (!/^[a-z0-9]{3,24}$/.test(account)) throw bad('account is the storage account name: 3 to 24 lowercase letters and digits.');
    if (!/^(?=.{3,63}$)[a-z0-9](?:[a-z0-9]|-(?!-))*[a-z0-9]$/.test(bucket)) throw bad('container is 3 to 63 lowercase letters, digits and single dashes.');
    endpoint ??= `https://${account}.blob.core.windows.net`;
    region = '';
    url = `azure://${account}/${bucket}${pfx}?endpoint=${encodeURIComponent(endpoint)}`;
  } else {
    account = '';
    const re = provider === 'gcs' ? /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/ : /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
    if (!re.test(bucket) || bucket.includes('..')) throw bad('bucket is the bucket name: lowercase letters, digits, dots and dashes.');
    if (provider === 'gcs') {
      endpoint ??= 'https://storage.googleapis.com';
      region = '';
      url = `gs://${bucket}${pfx}?endpoint=${encodeURIComponent(endpoint)}`;
    } else if (provider === 'r2') {
      if (!endpoint) throw bad('endpoint is required for R2: https://<account_id>.r2.cloudflarestorage.com.');
      region = 'auto';
      url = `s3://${bucket}${pfx}?endpoint=${encodeURIComponent(endpoint)}&region=auto`;
    } else {
      region ||= 'us-east-1';
      if (!/^[a-z0-9-]{1,32}$/.test(region)) throw bad('region looks like us-east-1.');
      endpoint ??= `https://s3.${region}.amazonaws.com`;
      url = `s3://${bucket}${pfx}?endpoint=${encodeURIComponent(endpoint)}&region=${region}`;
    }
  }
  return { provider, bucket, prefix, endpoint, region, account, url };
}

// The secrets, checked. Returned as the env createStorage reads.
export function normalizeCredentials(provider, input) {
  if (provider === 'azure') {
    const key = fieldOf(input, 'account_key').replace(/\s+/g, '');
    if (!key) throw bad('account_key is required: an access key of the storage account, as the portal shows it.');
    if (key.length > 200 || !/^[A-Za-z0-9+/]+={0,2}$/.test(key) || Buffer.from(key, 'base64').length < 32) throw bad('account_key is the base64 key from the portal (Access keys).');
    return { GRAPIM_AZURE_ACCOUNT_KEY: key };
  }
  const id = fieldOf(input, 'access_key_id');
  const secret = fieldOf(input, 'secret_access_key');
  if (!id || !secret) throw bad(provider === 'gcs' ? 'access_key_id and secret_access_key are required: an HMAC key of a service account.' : 'access_key_id and secret_access_key are required.');
  if (!PRINTABLE.test(id) || !PRINTABLE.test(secret)) throw bad('access_key_id and secret_access_key are up to 256 printable characters, without spaces.');
  return provider === 'gcs' ? { GRAPIM_GCS_ACCESS_KEY_ID: id, GRAPIM_GCS_SECRET_ACCESS_KEY: secret } : { GRAPIM_S3_ACCESS_KEY_ID: id, GRAPIM_S3_SECRET_ACCESS_KEY: secret };
}

const publicConfig = (c) => (c ? { provider: c.provider, bucket: c.bucket, prefix: c.prefix, endpoint: c.endpoint, region: c.region || null, account: c.account || null } : null);

// Removes every secret value from a message, whatever produced it.
function scrub(message, env) {
  let out = String(message ?? '').slice(0, 500);
  for (const v of Object.values(env || {})) if (v && v.length >= 4) out = out.split(v).join('[redacted]');
  return out;
}

// ------------------------------------------------------- the safe fetch ----

// fetch() for a team's bucket: the endpoint is vetted (https, every address
// public) at most once a minute, the connection goes to the vetted address,
// redirects are never followed, and replies are capped. `transport(url, init,
// vetted)` replaces the connection itself (tests).
export function makeSafeFetch({ resolve = defaultResolve, transport = null, maxReply = MAX_REPLY, now = () => Date.now() } = {}) {
  const cache = new Map(); // origin -> { at, vetted }
  async function vetted(origin) {
    const hit = cache.get(origin);
    if (hit && now() - hit.at < VET_TTL_MS) return hit.vetted;
    const v = await vet(origin, resolve);
    cache.set(origin, { at: now(), vetted: v });
    if (cache.size > 1000) cache.delete(cache.keys().next().value);
    return v;
  }
  return async function safeFetch(target, init = {}) {
    const u = new URL(target);
    let v;
    try {
      v = await vetted(u.origin);
    } catch (err) {
      const e = new Error(err instanceof UrlRefused ? `endpoint refused: ${err.code === 'url_unresolvable' ? 'it does not resolve' : 'it must be https on a public address'}` : 'endpoint refused');
      e.code = 'endpoint_refused';
      throw e;
    }
    if (transport) return transport(target, init, v);
    return pinnedFetch(v, u, init, maxReply);
  };
}

function pinnedFetch({ host, address, family }, u, init, maxReply) {
  return new Promise((resolve, reject) => {
    const headers = { ...(init.headers || {}), Host: u.host };
    if (init.body) headers['Content-Length'] = init.body.length;
    const req = https.request({
      protocol: 'https:',
      host,
      servername: net.isIP(host) ? undefined : host,
      port: u.port || 443,
      path: `${u.pathname}${u.search}`,
      method: init.method || 'GET',
      headers,
      agent: false,
      lookup: (_h, opts, cb) => (opts?.all ? cb(null, [{ address, family }]) : cb(null, address, family)),
      signal: init.signal,
    });
    req.on('error', reject);
    req.on('response', (res) => {
      const chunks = [];
      let n = 0;
      res.on('data', (c) => {
        n += c.length;
        if (n > maxReply) res.destroy(Object.assign(new Error('reply too large'), { code: 'reply_too_large' }));
        else chunks.push(c);
      });
      res.on('error', reject);
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          headers: {
            get: (name) => {
              const v = res.headers[String(name).toLowerCase()];
              return v === undefined ? null : Array.isArray(v) ? v.join(', ') : String(v);
            },
          },
          arrayBuffer: async () => Buffer.concat(chunks),
        }),
      );
    });
    req.end(init.body);
  });
}

// ----------------------------------------------------------- the module ----

// options: { resolve, transport (tests: the connection), storageOpts (retry,
// timeoutMs for the clients), probeOpts, onCopied(teamId, key) (tests: inject a
// crash), createStorage (tests) }.
export function createTeamStorage(hub, { defaultStorage = null, resolve = defaultResolve, transport = null, storageOpts = {}, probeOpts = {}, onCopied = null, createStorage = null } = {}) {
  const { db, log } = hub;
  const now = hub.now ?? (() => Date.now());
  db.exec(SCHEMA);
  const sealer = makeSealer(hub.config.secret);
  const aad = (column, teamId) => `team_storage.${column}\n${teamId}`;
  const safeFetch = makeSafeFetch({ resolve, transport, now });
  let createStorageFn = createStorage;
  const loadCreate = async () => (createStorageFn ??= (await import('../storage/index.js')).createStorage);
  // Loaded before the hub serves anything (server.js awaits it).
  const ready = defaultStorage ? loadCreate().catch((err) => log(`team storage is off: ${err?.message ?? err}`)) : Promise.resolve();

  const rows = new Map(); // team id -> row | null (cache; only this module writes the table)
  const stores = new Map(); // `${team}:${slot}` -> { sig, store }
  const jobs = new Map(); // team id -> promise
  const inflight = new Map(); // team id -> dual writes in flight
  const dirty = new Map(); // team id -> Set of keys a dual write failed to reach in the new store
  const locks = new Map(); // key -> promise chain (manifests during a move)
  const gens = new Map(); // team id -> generation of its move, so a cancelled job stops
  let closed = false;
  const bump = (teamId) => gens.set(teamId, (gens.get(teamId) ?? 0) + 1);

  const rowOf = (teamId) => {
    if (!rows.has(teamId)) rows.set(teamId, db.prepare('SELECT * FROM team_storage WHERE team_id = ?').get(teamId) ?? null);
    return rows.get(teamId);
  };
  // Stores are cached by (url, sealed credentials), so a row reload keeps them.
  const forget = (teamId) => rows.delete(teamId);
  const update = (teamId, sql, ...args) => {
    db.prepare(`UPDATE team_storage SET ${sql} WHERE team_id = ?`).run(...args, teamId);
    forget(teamId);
  };

  // ---- stores ----

  const parse = (json) => {
    try {
      return json ? JSON.parse(json) : null;
    } catch {
      return null;
    }
  };

  function unreadable() {
    const e = new Error("this team's storage credentials cannot be read (HUB_SECRET changed?); an owner must enter them again");
    e.code = 'credentials_unreadable';
    e.retryable = false;
    return e;
  }

  // The store of a slot ('active' or 'move'): the hub's own when it has no config.
  function storeOf(teamId, slot) {
    const row = rowOf(teamId);
    const cfg = parse(slot === 'active' ? row?.config : row?.move_config);
    if (!cfg) return defaultStorage;
    const sealed = slot === 'active' ? row.credentials : row.move_credentials;
    const sig = `${cfg.url}\n${sealed}`;
    const k = `${teamId}:${slot}`;
    const hit = stores.get(k);
    if (hit?.sig === sig) return hit.store;
    const text = sealer.open(sealed, aad(slot === 'active' ? 'credentials' : 'move_credentials', teamId));
    if (text === null) throw unreadable();
    if (!createStorageFn) throw Object.assign(new Error('storage module not loaded yet'), { retryable: true });
    const store = createStorageFn(cfg.url, JSON.parse(text), { retry: { retries: 4, baseDelayMs: 200, maxDelayMs: 5000 }, ...storageOpts, fetch: safeFetch });
    stores.set(k, { sig, store });
    return store;
  }

  // ---- the router: what the workspace storage writes through ----

  const teamOf = (key) => TEAM_KEY.exec(key)?.[1] ?? null;
  const moving = (teamId) => !!rowOf(teamId)?.move_state;

  async function withLock(key, fn) {
    const prev = locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    locks.set(key, tail);
    try {
      return await run;
    } finally {
      if (locks.get(key) === tail) locks.delete(key);
    }
  }

  async function dualWrite(teamId, key, fn) {
    const from = storeOf(teamId, 'active');
    const to = storeOf(teamId, 'move');
    inflight.set(teamId, (inflight.get(teamId) ?? 0) + 1);
    try {
      await withLock(key, async () => {
        await fn(from); // the old store stays authoritative until the switch
        try {
          await fn(to);
        } catch (err) {
          if (!dirty.has(teamId)) dirty.set(teamId, new Set());
          dirty.get(teamId).add(key);
          log(`team storage: write to the new store of ${teamId} failed, it will be copied again: ${err?.message ?? err}`);
        }
      });
    } finally {
      inflight.set(teamId, inflight.get(teamId) - 1);
    }
  }

  async function readFirst(teamId, key, op, empty) {
    const from = storeOf(teamId, 'active');
    const to = storeOf(teamId, 'move');
    // Blobs never change: the new store first. Manifests change: the old
    // store, which every write reaches first, until the switch.
    const order = BLOB_KEY.test(key) ? [to, from] : [from, to];
    let firstErr = null;
    for (const s of order) {
      try {
        const v = await s[op](key);
        if (v !== empty) return v;
      } catch (err) {
        firstErr ??= err;
      }
    }
    if (firstErr) throw firstErr;
    return empty;
  }

  const router = {
    kind: 'team-router',
    describe: () => (defaultStorage?.describe ? `${defaultStorage.describe()} (and teams' own buckets)` : "teams' buckets"),
    async put(key, buf) {
      const t = teamOf(key);
      if (!t) return defaultStorage.put(key, buf);
      if (moving(t)) return dualWrite(t, key, (s) => s.put(key, buf));
      return storeOf(t, 'active').put(key, buf);
    },
    async get(key) {
      const t = teamOf(key);
      if (!t) return defaultStorage.get(key);
      if (moving(t)) return readFirst(t, key, 'get', null);
      return storeOf(t, 'active').get(key);
    },
    async has(key) {
      const t = teamOf(key);
      if (!t) return defaultStorage.has(key);
      if (moving(t)) return readFirst(t, key, 'has', false);
      return storeOf(t, 'active').has(key);
    },
    async delete(key) {
      const t = teamOf(key);
      if (!t) return defaultStorage.delete(key);
      if (moving(t)) return dualWrite(t, key, (s) => s.delete(key));
      return storeOf(t, 'active').delete(key);
    },
    async list(prefix = '') {
      const t = teamOf(prefix);
      if (!t) return defaultStorage.list(prefix);
      if (!moving(t)) return storeOf(t, 'active').list(prefix);
      const [a, b] = await Promise.all([storeOf(t, 'active').list(prefix), storeOf(t, 'move').list(prefix).catch(() => [])]);
      return [...new Set([...a, ...b])].sort();
    },
  };

  // ---- the probe ----

  // Puts, reads back, lists and deletes a random key. Throws a 400 naming the
  // step that failed; the probe key is deleted whatever happens.
  async function probe(store, env) {
    const key = `grapim-probe/${crypto.randomBytes(16).toString('hex')}`;
    const body = crypto.randomBytes(32);
    let step = 'writing a test object';
    let wrote = false;
    try {
      // Set first: a put that fails after the object landed (a timeout, a
      // dropped reply) still leaves it behind, so it is deleted too (batch 5, L4).
      wrote = true;
      await store.put(key, body);
      step = 'reading the test object back';
      const back = await store.get(key);
      if (!back || !Buffer.from(back).equals(body)) throw new Error('it came back different');
      step = 'listing the test object';
      if (!(await store.list('grapim-probe/')).includes(key)) throw new Error('it was not listed');
      step = 'deleting the test object';
      await store.delete(key);
      if (await store.has(key)) throw new Error('it is still there (the key needs delete permission)');
      wrote = false;
    } catch (err) {
      throw new HttpError(400, 'storage_unreachable', `Grapim could not use this bucket: ${step} failed: ${scrub(err?.message ?? err, env)}. Nothing was saved.`);
    } finally {
      if (wrote) await store.delete(key).catch(() => {});
    }
  }

  // ---- saving ----

  const probing = new Set();

  async function vetEndpoint(cfg) {
    try {
      await vet(cfg.endpoint, resolve);
    } catch (err) {
      if (err instanceof UrlRefused) {
        throw bad(err.code === 'url_unresolvable' ? `endpoint ${new URL(cfg.endpoint).host} does not resolve.` : `endpoint ${new URL(cfg.endpoint).host} must resolve to public addresses only (no private, loopback, link-local or metadata addresses).`);
      }
      throw err;
    }
  }

  // Sets the team's storage to `input` (the form or the API's fields), or
  // back to the hub's own when input is null. Resolves to { action }.
  async function configure(teamId, input, by) {
    if (!defaultStorage) throw new HttpError(409, 'storage_unavailable', 'Workspace storage is off on this hub, so there is nothing to move.');
    const row = rowOf(teamId);
    if (row?.move_state) throw new HttpError(409, 'storage_moving', 'A move to another store is in progress. Wait for it to finish, or cancel it.');
    if (input === null || (input && typeof input === 'object' && String(input.provider ?? '').toLowerCase() === 'hub')) return moveToHub(teamId, by);
    const cfg = normalizeConfig(input);
    const env = normalizeCredentials(cfg.provider, input);
    if (probing.has(teamId)) throw new HttpError(409, 'busy', 'Another storage test of this team is running. Try again in a moment.');
    probing.add(teamId);
    try {
      await vetEndpoint(cfg);
      const create = await loadCreate();
      let store;
      try {
        store = create(cfg.url, env, { retry: { retries: 1, baseDelayMs: 100, maxDelayMs: 500 }, timeoutMs: 10_000, ...storageOpts, ...probeOpts, fetch: safeFetch });
      } catch (err) {
        throw bad(scrub(err?.message ?? err, env));
      }
      await probe(store, env);
    } finally {
      probing.delete(teamId);
    }
    if (rowOf(teamId)?.move_state) throw new HttpError(409, 'storage_moving', 'A move to another store started meanwhile. Wait for it to finish, or cancel it.');
    const t = now();
    const config = JSON.stringify(cfg);
    db.prepare('INSERT OR IGNORE INTO team_storage (team_id) VALUES (?)').run(teamId);
    forget(teamId);
    const active = parse(rowOf(teamId).config);
    if (active && active.url === cfg.url) {
      // The same bucket: new credentials, nothing to copy.
      update(teamId, 'config = ?, credentials = ?, saved_at = ?, saved_by = ?', config, sealer.seal(JSON.stringify(env), aad('credentials', teamId)), t, by);
      log(`team storage: ${teamId} replaced its ${cfg.provider} credentials`);
      return { action: 'replaced' };
    }
    update(
      teamId,
      "move_state = 'copying', move_config = ?, move_credentials = ?, move_pass = 0, move_cursor = NULL, move_done = 0, move_total = 0, move_copied = 0, move_error = NULL, move_started_at = ?, move_updated_at = ?, move_by = ?",
      config,
      sealer.seal(JSON.stringify(env), aad('move_credentials', teamId)),
      t,
      t,
      by,
    );
    dirty.delete(teamId);
    bump(teamId);
    log(`team storage: ${teamId} is moving to ${cfg.provider}`);
    start(teamId);
    return { action: 'moving' };
  }

  function moveToHub(teamId, by) {
    const row = rowOf(teamId);
    if (!row?.config) throw new HttpError(409, 'storage_unchanged', "This team already uses the hub's storage.");
    const t = now();
    update(
      teamId,
      "move_state = 'copying', move_config = NULL, move_credentials = NULL, move_pass = 0, move_cursor = NULL, move_done = 0, move_total = 0, move_copied = 0, move_error = NULL, move_started_at = ?, move_updated_at = ?, move_by = ?",
      t,
      t,
      by,
    );
    dirty.delete(teamId);
    bump(teamId);
    log(`team storage: ${teamId} is moving back to the hub's storage`);
    start(teamId);
    return { action: 'moving' };
  }

  function cancel(teamId) {
    const row = rowOf(teamId);
    if (!row?.move_state) throw new HttpError(409, 'storage_not_moving', 'No move is in progress.');
    update(teamId, 'move_state = NULL, move_config = NULL, move_credentials = NULL, move_pass = 0, move_cursor = NULL, move_done = 0, move_total = 0, move_copied = 0, move_error = NULL');
    dirty.delete(teamId);
    bump(teamId);
    log(`team storage: ${teamId} cancelled its move`);
  }

  function retry(teamId) {
    const row = rowOf(teamId);
    if (row?.move_state !== 'failed') throw new HttpError(409, 'storage_not_failed', 'Only a move that failed can be retried.');
    update(teamId, "move_state = 'copying', move_error = NULL, move_updated_at = ?", now());
    start(teamId);
  }

  // ---- the move job ----

  function start(teamId) {
    if (closed || jobs.has(teamId)) return jobs.get(teamId);
    const p = ready.then(() => run(teamId)).finally(() => jobs.delete(teamId));
    jobs.set(teamId, p);
    return p;
  }

  // One key from the old store to the new. True when it wrote.
  async function copyKey(teamId, key, from, to) {
    const blob = BLOB_KEY.exec(key);
    if (blob) {
      if (await to.has(key)) return false;
      const buf = await from.get(key);
      if (!buf) return false; // deleted since the listing
      if (sha1(buf) !== blob[1]) throw Object.assign(new Error(`blob ${blob[1]} in the old store does not match its sha1; not copied`), { retryable: false });
      await to.put(key, buf);
      return true;
    }
    // A manifest: under the key's lock, so a dual write cannot interleave.
    return withLock(key, async () => {
      const buf = await from.get(key);
      if (!buf) return false;
      const cur = await to.get(key).catch(() => null);
      if (cur && Buffer.from(cur).equals(buf)) return false;
      await to.put(key, buf);
      return true;
    });
  }

  const stillMoving = (teamId, gen) => !closed && rowOf(teamId)?.move_state === 'copying' && (gens.get(teamId) ?? 0) === gen;

  async function run(teamId) {
    let row = rowOf(teamId);
    if (row?.move_state !== 'copying') return;
    const started = gens.get(teamId) ?? 0;
    const prefix = `ws/${teamId}/`;
    try {
      const from = storeOf(teamId, 'active');
      const to = storeOf(teamId, 'move');
      for (let pass = row.move_pass; pass < MAX_PASSES; pass++) {
        row = rowOf(teamId);
        const cursor = row.move_cursor;
        const pending = dirty.get(teamId) ?? new Set();
        dirty.delete(teamId);
        const keys = (await from.list(prefix)).filter((k) => k.startsWith(prefix)).sort();
        let done = cursor ? keys.filter((k) => k <= cursor).length : 0;
        let copied = row.move_copied;
        update(teamId, 'move_total = ?, move_done = ?, move_copied = ?, move_updated_at = ?', keys.length, done, copied, now());
        let changed = 0;
        for (const key of keys) {
          if (cursor && key <= cursor) continue;
          if (!stillMoving(teamId, started)) return;
          if (await copyKey(teamId, key, from, to)) {
            changed++;
            copied++;
          }
          pending.delete(key);
          done++;
          update(teamId, 'move_cursor = ?, move_done = ?, move_copied = ?, move_updated_at = ?', key, done, copied, now());
          if (onCopied) await onCopied(teamId, key);
        }
        // Keys a dual write could not put in the new store, not listed again above.
        for (const key of pending) {
          if (!stillMoving(teamId, started)) return;
          if (await copyKey(teamId, key, from, to)) changed++;
        }
        if (!stillMoving(teamId, started)) return;
        update(teamId, 'move_pass = ?, move_cursor = NULL, move_copied = 0, move_updated_at = ?', pass + 1, now());
        // A pass that copied nothing: everything is in the new store. Switch,
        // once no dual write is in flight and none missed the new store.
        if (changed === 0 && pass > 0) {
          for (let i = 0; i < 200 && (inflight.get(teamId) ?? 0) > 0; i++) await new Promise((r) => setTimeout(r, 25));
          if ((inflight.get(teamId) ?? 0) === 0 && !(dirty.get(teamId)?.size)) {
            switchOver(teamId);
            return;
          }
        }
      }
      throw Object.assign(new Error(`the files kept changing during ${MAX_PASSES} passes; retry when the workspaces are quieter`), { retryable: false });
    } catch (err) {
      if (!stillMoving(teamId, started)) return;
      const message = scrub(err?.message ?? err, {}).slice(0, 300);
      update(teamId, "move_state = 'failed', move_error = ?, move_updated_at = ?", message, now());
      log(`team storage: the move of ${teamId} failed: ${message}`);
    }
  }

  // Synchronous: no write can start between the checks above and this.
  function switchOver(teamId) {
    const row = rowOf(teamId);
    const cfg = parse(row.move_config);
    let creds = null;
    if (cfg) {
      const text = sealer.open(row.move_credentials, aad('move_credentials', teamId));
      if (text === null) throw unreadable();
      creds = sealer.seal(text, aad('credentials', teamId));
    }
    const t = now();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        'UPDATE team_storage SET config = ?, credentials = ?, saved_at = ?, saved_by = move_by, move_state = NULL, move_config = NULL, move_credentials = NULL, move_pass = 0, move_cursor = NULL, move_error = NULL, move_updated_at = ? WHERE team_id = ?',
      ).run(cfg ? row.move_config : null, creds, t, t, teamId);
      db.prepare('UPDATE teams SET storage_url = ? WHERE id = ?').run(cfg ? cfg.url : null, teamId);
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {}
      throw err;
    } finally {
      forget(teamId);
    }
    dirty.delete(teamId);
    log(`team storage: ${teamId} now uses ${cfg ? cfg.provider : "the hub's storage"}`);
  }

  // Moves that were copying when the hub stopped carry on from their cursor.
  function resume() {
    if (!defaultStorage) return [];
    const ids = db.prepare("SELECT team_id FROM team_storage WHERE move_state = 'copying'").all().map((r) => r.team_id);
    return ids.map((id) => start(id));
  }

  // ---- what pages and the API show ----

  function status(teamId) {
    const row = rowOf(teamId);
    const cfg = parse(row?.config);
    const moveTo = row?.move_state ? parse(row.move_config) : undefined;
    return {
      available: !!defaultStorage,
      provider: cfg ? cfg.provider : 'hub',
      config: publicConfig(cfg),
      saved_at: cfg ? row.saved_at : null,
      credentials_ok: cfg ? sealer.open(row.credentials, aad('credentials', teamId)) !== null : null,
      move: row?.move_state
        ? { state: row.move_state, to: moveTo ? moveTo.provider : 'hub', config: publicConfig(moveTo), pass: row.move_pass, done: row.move_done, total: row.move_total, copied: row.move_copied, error: row.move_error, started_at: row.move_started_at, updated_at: row.move_updated_at }
        : null,
    };
  }

  // /v1/settings: no secrets, ever.
  function statusJson(teamId) {
    const s = status(teamId);
    return {
      object: 'storage',
      ...(s.config ?? { bucket: null, prefix: null, endpoint: null, region: null, account: null }),
      provider: s.provider,
      credentials: s.config ? (s.credentials_ok ? 'saved' : 'unreadable') : null,
      move: s.move ? { state: s.move.state, to: s.move.to, ...(s.move.config ? { bucket: s.move.config.bucket, prefix: s.move.config.prefix, endpoint: s.move.config.endpoint } : {}), done: s.move.done, total: s.move.total, copied: s.move.copied, pass: s.move.pass, error: s.move.error } : null,
    };
  }

  function settingsSection(team, csrf, extra = {}) {
    return storageSection({ team, csrf, status: status(team.id), providers: PROVIDERS, ...extra });
  }

  // ---- hub pages (owner only) ----

  function routes(router) {
    const OWNER_FORM = { auth: 'session', csrf: true, team: true, owner: true };
    const back = (ctx) => redirect(ctx.res, `/hub/teams/${ctx.member.team.id}/settings/data#storage`);
    const by = (ctx) => `user:${ctx.session.user.id}`;
    // A refusal is shown on the settings page, in the card, with what was typed (never the secrets).
    async function onCard(ctx, fn) {
      try {
        await fn();
      } catch (err) {
        if (err instanceof HttpError && err.status < 500 && err.status !== 404 && err.status !== 403 && hub.renderSettings) {
          const form = {};
          for (const k of ['provider', 'bucket', 'prefix', 'endpoint', 'region', 'account']) if (typeof ctx.form?.[k] === 'string') form[k] = ctx.form[k].slice(0, 300);
          const team = hub.teams.get(ctx.member.team.id);
          hub.renderSettings(ctx, { storage: settingsSection(team, ctx.session.csrf, { error: err.message, form }) }, err.status);
          return;
        }
        throw err;
      }
    }
    router.post(
      '/hub/teams/:team/storage',
      (ctx) =>
        onCard(ctx, async () => {
          await configure(ctx.member.team.id, ctx.form, by(ctx));
          back(ctx);
        }),
      OWNER_FORM,
    );
    router.post(
      '/hub/teams/:team/storage/hub',
      (ctx) =>
        onCard(ctx, async () => {
          await configure(ctx.member.team.id, null, by(ctx));
          back(ctx);
        }),
      OWNER_FORM,
    );
    router.post(
      '/hub/teams/:team/storage/cancel',
      (ctx) =>
        onCard(ctx, () => {
          cancel(ctx.member.team.id);
          back(ctx);
        }),
      OWNER_FORM,
    );
    router.post(
      '/hub/teams/:team/storage/retry',
      (ctx) =>
        onCard(ctx, () => {
          retry(ctx.member.team.id);
          back(ctx);
        }),
      OWNER_FORM,
    );
  }

  return {
    router: defaultStorage ? router : null,
    ready,
    available: !!defaultStorage,
    configure,
    cancel,
    retry,
    resume,
    status,
    statusJson,
    settingsSection,
    routes,
    probe,
    storeOf,
    safeFetch,
    // Resolves when the team's move job (if any) has stopped (tests).
    job: (teamId) => jobs.get(teamId) ?? Promise.resolve(),
    close() {
      closed = true;
    },
  };
}
