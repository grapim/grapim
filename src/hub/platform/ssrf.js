// Outbound webhook requests that cannot be pointed at the hub's own network
// (SSRF): https only, no credentials in the URL, every address the name
// resolves to must be public, and the connection goes to the address that
// was checked (no second DNS lookup an attacker could rebind). No redirects
// are followed, the whole request has a 10 s budget, and at most 64 KB of the
// reply is read.

import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';

export const TIMEOUT_MS = 10_000;
const MAX_REPLY = 64 * 1024;

// Not routable on the public internet, or reserved: loopback, private,
// link-local (cloud metadata at 169.254.169.254 and fd00:ec2::254), CGNAT
// (Alibaba's metadata at 100.100.100.200), documentation, benchmarking,
// multicast, broadcast and "this network".
const BLOCKED = new net.BlockList();
for (const [a, p] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) {
  BLOCKED.addSubnet(a, p, 'ipv4');
}
for (const [a, p] of [
  ['::', 96], // unspecified, loopback and the deprecated IPv4-compatible ::a.b.c.d (review M5)
  ['::ffff:0:0:0', 96], // SIIT IPv4-translated (RFC 2765)
  ['64:ff9b:1::', 48], // local-use NAT64 (RFC 8215): reaches whatever IPv4 the NAT64 can
  ['100::', 64],
  ['2001::', 32], // Teredo
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
]) {
  BLOCKED.addSubnet(a, p, 'ipv6');
}

// The IPv4 address inside an IPv6 one that carries it (mapped, compatible,
// NAT64, 6to4), or null.
function embeddedV4(ip) {
  const lower = ip.toLowerCase();
  const dotted = /^(?:::ffff:|::|64:ff9b::)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (dotted) return dotted[1];
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16);
    return [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');
  }
  const sixToFour = /^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/.exec(lower);
  if (sixToFour) {
    const n = (parseInt(sixToFour[1], 16) << 16) | parseInt(sixToFour[2], 16);
    return [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');
  }
  return null;
}

// True if the hub must never connect to this address.
export function isBlockedAddress(ip) {
  const v = net.isIP(ip);
  if (v === 4) return BLOCKED.check(ip, 'ipv4');
  if (v === 6) {
    const v4 = embeddedV4(ip);
    if (v4) return isBlockedAddress(v4) || BLOCKED.check(ip, 'ipv6');
    return BLOCKED.check(ip, 'ipv6');
  }
  return true; // not an address at all
}

export class UrlRefused extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// The shape check, before any lookup.
export function parseWebhookUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2000) throw new UrlRefused('url_invalid', 'url must be a string of at most 2000 characters.');
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new UrlRefused('url_invalid', 'url is not a valid URL.');
  }
  if (u.protocol !== 'https:') throw new UrlRefused('url_not_allowed', 'Webhook URLs must use https.');
  if (u.username || u.password) throw new UrlRefused('url_not_allowed', 'Webhook URLs cannot carry a user name or password.');
  // 'localhost.' is 'localhost': one trailing dot names the same host (review M5).
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  // A name without a dot is completed from the hub's own resolver search list
  // (redis, postgres, a private service name): never a public host (review M5).
  if (host && !net.isIP(host) && !host.includes('.')) throw new UrlRefused('url_not_allowed', 'Webhook URLs must point at a public host.');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new UrlRefused('url_not_allowed', 'Webhook URLs must point at a public host.');
  }
  if (net.isIP(host) && isBlockedAddress(host)) throw new UrlRefused('url_not_allowed', 'Webhook URLs must point at a public address.');
  return { url: u, host };
}

export const DNS_TIMEOUT_MS = 5000;

// A resolver for webhook hosts. dns.lookup() (getaddrinfo) runs on libuv's
// threadpool, 4 threads shared with every fs.promises call, zlib and every
// other lookup (sign in, storage): a webhook host whose DNS never answers
// would stall the whole hub. c-ares queries run on the event loop and give
// up after `timeoutMs` (review H1). /etc/hosts is not read: webhook hosts
// are public names.
export function makeResolver({ servers = null, timeoutMs = DNS_TIMEOUT_MS } = {}) {
  const r = new dns.promises.Resolver({ timeout: Math.max(1, Math.floor(timeoutMs / 2)), tries: 2 });
  if (servers) r.setServers(servers);
  return async (host) => {
    const settle = (p, fam) => p.then((list) => list.map((address) => ({ address, family: fam })), () => []);
    const [v4, v6] = await Promise.all([settle(r.resolve4(host), 4), settle(r.resolve6(host), 6)]);
    const all = [...v4, ...v6];
    if (!all.length) throw new Error(`${host} does not resolve`);
    return all;
  };
}

export const defaultResolve = makeResolver();

// The one public address to connect to, or a UrlRefused. Every address the
// name has must be public: a name with one private address is refused. The
// lookup has its own time limit, whatever resolver is used.
export async function vet(raw, resolve = defaultResolve, { timeoutMs = DNS_TIMEOUT_MS } = {}) {
  const { url, host } = parseWebhookUrl(raw);
  let addrs;
  if (net.isIP(host)) addrs = [{ address: host, family: net.isIP(host) }];
  else {
    let timer;
    try {
      addrs = await Promise.race([
        resolve(host),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('timed out')), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } catch {
      throw new UrlRefused('url_unresolvable', `${host} does not resolve.`);
    } finally {
      clearTimeout(timer);
    }
  }
  if (!Array.isArray(addrs) || !addrs.length) throw new UrlRefused('url_unresolvable', `${host} does not resolve.`);
  for (const a of addrs) {
    if (isBlockedAddress(String(a?.address ?? ''))) throw new UrlRefused('url_not_allowed', `${host} resolves to a private or reserved address.`);
  }
  const pick = addrs[0];
  return { url, host, address: pick.address, family: net.isIP(pick.address) };
}

// POSTs `body` to the vetted address with TLS for the URL's host name. Never
// follows a redirect (https.request does not). Resolves { status }.
export function pinnedPost({ url, host, address, family }, { headers, body, timeoutMs = TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      protocol: 'https:',
      host,
      servername: net.isIP(host) ? undefined : host,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers: { ...headers, Host: url.host, 'Content-Length': Buffer.byteLength(body) },
      agent: false,
      lookup: (_h, opts, cb) => (opts?.all ? cb(null, [{ address, family }]) : cb(null, address, family)),
      signal: AbortSignal.timeout(timeoutMs),
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.on('response', (res) => {
      let n = 0;
      res.on('data', (c) => {
        n += c.length;
        if (n > MAX_REPLY) res.destroy();
      });
      res.on('close', () => resolve({ status: res.statusCode }));
      res.on('error', () => resolve({ status: res.statusCode }));
    });
    req.end(body);
  });
}
