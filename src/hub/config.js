// Hub configuration, read once from the environment. The hub refuses to start
// without every required variable, rather than running half configured.

import path from 'node:path';

export const REQUIRED = ['HUB_URL', 'HUB_SECRET', 'HUB_DATA', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'];

export class ConfigError extends Error {}

// Length times the Shannon entropy of the character distribution: a rough,
// conservative-for-random estimate of a secret's strength in bits.
export function estimatedBits(s) {
  const counts = new Map();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  const n = [...s].length;
  let h = 0;
  for (const k of counts.values()) h -= (k / n) * Math.log2(k / n);
  return h * n;
}

// True when s is one short unit repeated ("changeme" * 4, "0123456789" * 4).
function repeats(s) {
  for (let p = 1; p <= 16 && p * 2 <= s.length; p++) {
    let same = true;
    for (let i = p; i < s.length && same; i++) same = s[i] === s[i % p];
    if (same) return true;
  }
  return false;
}

const isLocalHost = (host) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');

export function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((k) => !String(env[k] ?? '').trim());
  if (missing.length) {
    throw new ConfigError(`grapim hub: missing required environment variable${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. See .env.example and docs/deploy.md.`);
  }

  let url;
  try {
    url = new URL(env.HUB_URL.trim());
  } catch {
    throw new ConfigError('grapim hub: HUB_URL is not a valid URL (example: https://app.example.com).');
  }
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new ConfigError('grapim hub: HUB_URL must be a bare origin, like https://app.example.com, with no path.');
  }
  const local = isLocalHost(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new ConfigError('grapim hub: HUB_URL must use https (plain http is only allowed for localhost).');
  }

  const secret = env.HUB_SECRET;
  const generate = 'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"';
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new ConfigError(`grapim hub: HUB_SECRET must be at least 32 bytes. ${generate}`);
  }
  // Length alone lets "x" * 32 or "changeme" * 4 through. A random secret of
  // 32+ characters (hex, base64, base64url) scores over 90 bits by this
  // estimate and never repeats a short unit; those placeholders fail both.
  if (estimatedBits(secret) < 90 || repeats(secret)) {
    throw new ConfigError(`grapim hub: HUB_SECRET looks guessable (too few distinct characters). ${generate}`);
  }

  // Who may create teams. Unset: anyone who signs in with GitHub. For a
  // private beta, list GitHub logins or numeric user ids, comma separated.
  const creators = String(env.HUB_TEAM_CREATORS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const storageMb = env.HUB_TEAM_STORAGE_MB === undefined || env.HUB_TEAM_STORAGE_MB === '' ? 1024 : Number(env.HUB_TEAM_STORAGE_MB);
  if (!Number.isInteger(storageMb) || storageMb < 1) throw new ConfigError('grapim hub: HUB_TEAM_STORAGE_MB must be a whole number of megabytes.');
  // A platform team (docs/platform.md) holds one workspace per end customer:
  // its own quota, not the one meant for a small team.
  const platformMb = env.PLATFORM_STORAGE_MB === undefined || env.PLATFORM_STORAGE_MB === '' ? 20480 : Number(env.PLATFORM_STORAGE_MB);
  if (!Number.isInteger(platformMb) || platformMb < 1) throw new ConfigError('grapim hub: PLATFORM_STORAGE_MB must be a whole number of megabytes.');

  const port = env.PORT === undefined || env.PORT === '' ? 8080 : Number(env.PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError('grapim hub: PORT must be a port number.');

  // The Stripe keys are read by src/hub/billing.js itself (from the env the hub
  // passes it). The config keeps only whether they are set, never the values.
  const billingEnabled = !!(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET);
  const billingIntervals = ['month', 'year'].filter((i) => env[`STRIPE_PRICE_TEAM_${i.toUpperCase()}`]);
  const governanceIntervals = ['month', 'year'].filter((i) => env[`STRIPE_PRICE_GOVERNANCE_${i.toUpperCase()}`]);

  const config = {
    port,
    host: env.HOST || '0.0.0.0',
    origin: url.origin,
    secure: url.protocol === 'https:',
    dataDir: path.resolve(env.HUB_DATA),
    billingEnabled,
    billingIntervals: Object.freeze(billingIntervals),
    governanceIntervals: Object.freeze(governanceIntervals), // docs/provenance.md section 7
    // Behind Railway's (or any) proxy the client address is the last hop the
    // proxy appended to X-Forwarded-For. Only trust it when told to.
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
    teamCreators: creators.length ? Object.freeze(creators) : null,
    teamStorageBytes: storageMb * 1024 * 1024,
    platformStorageBytes: platformMb * 1024 * 1024,
  };
  // Secrets are non-enumerable, so logging or serialising the config by
  // mistake never prints them.
  const hidden = (obj, key, value) => Object.defineProperty(obj, key, { value, enumerable: false });
  hidden(config, 'secret', Buffer.from(secret, 'utf8'));
  const github = { clientId: env.GITHUB_CLIENT_ID.trim() };
  hidden(github, 'clientSecret', env.GITHUB_CLIENT_SECRET.trim());
  config.github = Object.freeze(github);
  return Object.freeze(config);
}
