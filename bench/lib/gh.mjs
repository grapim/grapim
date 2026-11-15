// Read-only GitHub access for the benchmark, through the `gh` CLI (its stored
// login), with every response cached under bench/cache/gh/ so a re-run makes
// no network calls. Nothing here writes to GitHub: only GET requests.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BENCH_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CACHE_DIR = path.join(BENCH_DIR, 'cache');
const GH_CACHE = path.join(CACHE_DIR, 'gh');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastSearch = 0;

function cacheFile(key) {
  return path.join(GH_CACHE, crypto.createHash('sha1').update(key).digest('hex') + '.json');
}

function readCache(key) {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(key), 'utf8')).value;
  } catch {
    return undefined;
  }
}

function writeCache(key, value) {
  fs.mkdirSync(GH_CACHE, { recursive: true });
  fs.writeFileSync(cacheFile(key), JSON.stringify({ key, value }));
}

function run(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

// The token of the `gh` login (or GITHUB_TOKEN), for plain fetch: spawning
// `gh api` per request is slow. Used only for GET requests.
let token;
function ghToken() {
  if (token !== undefined) return token;
  token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
  if (!token) {
    try {
      token = run(['auth', 'token']).trim() || null;
    } catch {
      token = null;
    }
  }
  return token;
}

async function getJson(url) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'grapim-bench', ...(ghToken() ? { authorization: `Bearer ${ghToken()}` } : {}) } });
    if ([404, 410, 451, 422].includes(res.status)) return { status: res.status, json: null, next: null };
    if ((res.status === 403 || res.status === 429 || res.status >= 500) && attempt < 4) {
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      const ra = Number(res.headers.get('retry-after'));
      const wait = ra ? ra * 1000 : res.headers.get('x-ratelimit-remaining') === '0' && reset ? Math.min(15 * 60_000, reset * 1000 - Date.now() + 2000) : 20_000 * (attempt + 1);
      await sleep(Math.max(1000, wait));
      continue;
    }
    if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const link = res.headers.get('link') ?? '';
    const next = /<([^>]+)>;\s*rel="next"/.exec(link)?.[1] ?? null;
    return { status: res.status, json: await res.json(), next };
  }
}

// GET one REST path (and its pages with paginate). Cached forever.
export async function api(route, { paginate = false, offline = false } = {}) {
  if (/^(?:-|.*\s)/.test(route)) throw new Error(`bad route ${route}`);
  const key = `api ${paginate ? 'paginate ' : ''}${route}`;
  const hit = readCache(key);
  if (hit !== undefined) return hit;
  if (offline) throw new Error(`not cached (offline): ${route}`);
  if (!process.env.BENCH_GH_CLI) {
    let url = `https://api.github.com/${route}`;
    let value = null;
    const pages = [];
    while (url) {
      const r = await getJson(url);
      if (r.json === null) {
        writeCache(key, null);
        return null;
      }
      if (!paginate) {
        value = r.json;
        break;
      }
      pages.push(r.json);
      url = r.next;
    }
    if (paginate) value = pages.flat();
    writeCache(key, value);
    return value;
  }
  const args = ['api', '-X', 'GET', '-H', 'Accept: application/vnd.github+json'];
  if (paginate) args.push('--paginate', '--slurp');
  args.push(route);
  let out;
  for (let attempt = 0; ; attempt++) {
    try {
      out = run(args);
      break;
    } catch (err) {
      const msg = String(err.stderr ?? err.message);
      if (/HTTP 404|HTTP 410|HTTP 451/.test(msg)) {
        writeCache(key, null);
        return null;
      }
      if (attempt < 3 && /rate limit|HTTP 403|HTTP 5\d\d|timeout|ECONNRESET/i.test(msg)) {
        await sleep(20_000 * (attempt + 1));
        continue;
      }
      throw new Error(`gh api ${route}: ${msg.slice(0, 300)}`);
    }
  }
  let value = JSON.parse(out || 'null');
  if (paginate && Array.isArray(value)) value = value.flat();
  writeCache(key, value);
  return value;
}

// The search API allows 30 requests a minute: one every 2.5 s here.
export async function searchIssues(q, { perPage = 100, page = 1, offline = false } = {}) {
  const route = `search/issues?q=${encodeURIComponent(q)}&per_page=${perPage}&page=${page}`;
  const key = `api ${route}`;
  const hit = readCache(key);
  if (hit !== undefined) return hit;
  const wait = lastSearch + 2500 - Date.now();
  if (wait > 0) await sleep(wait);
  lastSearch = Date.now();
  return api(route, { offline });
}

// The raw diff of a pull request between two commits is not needed: the
// harness reads git. This fetches a text body (a .diff or .patch) when asked.
export async function apiText(route, accept, { offline = false } = {}) {
  const key = `text ${accept} ${route}`;
  const hit = readCache(key);
  if (hit !== undefined) return hit;
  if (offline) throw new Error(`not cached (offline): ${route}`);
  const out = run(['api', '-X', 'GET', '-H', `Accept: ${accept}`, route]);
  writeCache(key, out);
  return out;
}
