// GitHub App configuration, from env. Every variable is optional for the hub:
// without them the App's routes answer "not configured" and nothing else
// changes. Secrets (the webhook secret, the private key) are non-enumerable,
// so logging the config never prints them.
//
//   GITHUB_APP_ID              the App's numeric id
//   GITHUB_APP_PRIVATE_KEY     its private key: the PEM itself (literal "\n" accepted) or base64 of it
//   GITHUB_APP_WEBHOOK_SECRET  the webhook secret set on the App
//   GITHUB_APP_SLUG            the App's URL name: https://github.com/apps/<slug>

import crypto from 'node:crypto';

export function parsePrivateKey(value) {
  let text = String(value ?? '').trim();
  if (!text) return null;
  if (!text.includes('-----BEGIN')) {
    const decoded = Buffer.from(text.replace(/\s+/g, ''), 'base64').toString('utf8');
    if (!decoded.includes('-----BEGIN')) throw new Error('GITHUB_APP_PRIVATE_KEY is neither a PEM nor base64 of one.');
    text = decoded;
  }
  text = text.replace(/\\n/g, '\n').replace(/\r\n/g, '\n');
  let key;
  try {
    key = crypto.createPrivateKey(text);
  } catch {
    throw new Error('GITHUB_APP_PRIVATE_KEY is not a readable private key.');
  }
  if (key.asymmetricKeyType !== 'rsa') throw new Error('GITHUB_APP_PRIVATE_KEY must be an RSA key (GitHub Apps sign with RS256).');
  return key;
}

export function githubConfig(env = process.env) {
  const problems = [];
  const id = String(env.GITHUB_APP_ID ?? '').trim();
  const slug = String(env.GITHUB_APP_SLUG ?? '').trim();
  const secret = String(env.GITHUB_APP_WEBHOOK_SECRET ?? '');
  let key = null;
  try {
    key = parsePrivateKey(env.GITHUB_APP_PRIVATE_KEY);
  } catch (err) {
    problems.push(err.message);
  }
  if (id && !/^\d{1,12}$/.test(id)) problems.push('GITHUB_APP_ID must be the numeric App id.');
  if (slug && !/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug)) problems.push('GITHUB_APP_SLUG must be the App URL name (lowercase letters, digits and dashes).');
  // The HMAC is the webhook's only authentication: a short secret is guessable offline from one captured delivery.
  if (secret && secret.length < 20) problems.push('GITHUB_APP_WEBHOOK_SECRET must be at least 20 characters (use a random string).');
  const cfg = {
    appId: /^\d{1,12}$/.test(id) ? id : null,
    slug: /^[a-z0-9][a-z0-9-]{0,99}$/.test(slug) ? slug : null,
    problems,
  };
  Object.defineProperty(cfg, 'webhookSecret', { value: secret || null, enumerable: false });
  Object.defineProperty(cfg, 'key', { value: key, enumerable: false });
  // Webhooks need the secret; acting on GitHub needs the id and key; the
  // install button needs the slug. "configured" means all four.
  cfg.canVerify = secret.length >= 20;
  cfg.canAct = !!(cfg.appId && key);
  cfg.configured = cfg.canVerify && cfg.canAct && !!cfg.slug && !problems.length;
  return Object.freeze(cfg);
}
