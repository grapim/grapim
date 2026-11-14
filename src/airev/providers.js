// Model providers: small adapters that send one Messages API body to the
// endpoint the customer chose, with the customer's credentials, and return the
// message. Plain fetch, no SDKs (the Action has no dependencies).
//
//   anthropic  POST https://api.anthropic.com/v1/messages, x-api-key
//   bedrock    POST https://bedrock-mantle.{region}.api.aws/anthropic/v1/messages, SigV4
//   vertex     POST https://{host}/v1/projects/{p}/locations/{r}/publishers/anthropic/models/{m}:rawPredict, Bearer
//   foundry    POST https://{resource}.services.ai.azure.com/anthropic/v1/messages, api-key
//
// Credentials live only in each provider's closure: never on the returned
// object, never in an error message or a log line.

import { signV4, sha256hex, toAmzDate } from '../storage/s3.js';
import { ConfigError } from './config.js';

export const ANTHROPIC_VERSION = '2026-10-21'; // as src/hub/agent/anthropic.js
export const VERTEX_VERSION = 'vertex-2023-10-16';
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
export const ANTHROPIC_URL = 'https://api.anthropic.com';
// Claude in Amazon Bedrock, the Messages API ("Mantle") endpoint.
export const BEDROCK_MANTLE_HOST = (region) => `bedrock-mantle.${region}.api.aws`;
export const BEDROCK_MANTLE_PATH = '/anthropic/v1/messages';
// TODO(bedrock): the SigV4 service name of the Mantle endpoint is not confirmed
// against AWS's docs; "bedrock-mantle" follows the host name. If requests come
// back 403 "Credential should be scoped to correct service", change it here.
export const BEDROCK_MANTLE_SIGV4_SERVICE = 'bedrock-mantle';
export const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

export class ProviderError extends Error {
  // fatal: no later request can succeed (credentials, model); the review stops.
  constructor(message, { status = null, type = null, retryable = false, fatal = false, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.type = type;
    this.retryable = retryable;
    this.fatal = fatal;
    this.retryAfterMs = retryAfterMs;
  }
}

const REGION = /^[a-z]{2,}(?:-[a-z0-9]+){1,4}$/;
const VERTEX_REGION = /^(?:global|us|eu|[a-z]+-[a-z]+\d+)$/;
const PROJECT = /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/;
const RESOURCE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?$/;

function timeoutSignal(signal) {
  const t = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, t]) : t;
}

// Sends and reads the reply; maps failures to ProviderErrors in plain words.
async function post(p, { url, headers, body, fetchImpl, signal }) {
  let res;
  try {
    res = await fetchImpl(url, { method: 'POST', headers, body, signal: timeoutSignal(signal) });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new ProviderError(`${p.label} could not be reached (${err?.name === 'TimeoutError' ? 'timed out' : 'network error'}).`, { retryable: true, type: 'network' });
  }
  let json = null;
  let text = '';
  try {
    text = await res.text();
    json = text ? JSON.parse(text) : null;
  } catch {}
  if (!res.ok) {
    const type = json?.error?.type ?? json?.type ?? null;
    const detail = String(json?.error?.message ?? json?.message ?? '').replace(/\s+/g, ' ').slice(0, 300);
    const s = res.status;
    const raw = res.headers?.get?.('retry-after');
    const ra = raw ? Number(raw) : NaN;
    const retryAfterMs = Number.isFinite(ra) && ra >= 0 ? Math.min(ra, 120) * 1000 : null;
    if (s === 401 || s === 403) throw new ProviderError(`${p.label} rejected the credentials (HTTP ${s}). ${p.credentialHint}${detail ? ` It said: ${detail}` : ''}`, { status: s, type, fatal: true });
    if (s === 404) throw new ProviderError(`${p.label} does not offer model "${p.model}" here (HTTP 404). Check the model id in .grapim/review.json and that the model is enabled${p.where ? ` in ${p.where}` : ''}.${detail ? ` It said: ${detail}` : ''}`, { status: s, type, fatal: true });
    const retryable = s === 408 || s === 409 || s === 429 || s >= 500;
    throw new ProviderError(`${p.label} answered HTTP ${s}${type ? ` (${type})` : ''}.${detail ? ` ${detail}` : ''}`, { status: s, type, retryable, retryAfterMs });
  }
  if (!json || typeof json !== 'object' || !Array.isArray(json.content)) throw new ProviderError(`${p.label} sent a reply that is not a message.`, { retryable: true, type: 'bad_reply' });
  return json;
}

function make(base, buildRequest, fetchDefault) {
  const p = {
    ...base,
    // body: a Messages API request. Returns the message JSON.
    async send(body, { fetchImpl, signal, now = () => new Date() } = {}) {
      const f = fetchImpl ?? fetchDefault ?? globalThis.fetch;
      const req = buildRequest(body, now());
      return post(p, { ...req, fetchImpl: f, signal });
    },
  };
  return Object.freeze(p);
}

export function anthropicProvider({ apiKey, model, baseUrl = ANTHROPIC_URL, fetchImpl, fallbacks = true } = {}) {
  if (!apiKey) throw new ConfigError('ANTHROPIC_API_KEY is not set. Add your Anthropic API key as a secret and pass it to the job as ANTHROPIC_API_KEY.');
  const root = String(baseUrl).replace(/\/+$/, '');
  return make(
    { name: 'anthropic', label: 'the Anthropic API', where: null, model, credentialHint: 'Check ANTHROPIC_API_KEY.' },
    (body) => {
      const headers = { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION };
      let b = body;
      // Server-side refusal fallback (Claude API only).
      if (fallbacks) {
        headers['anthropic-beta'] = FALLBACK_BETA;
        b = { ...body, fallbacks: 'default' };
      }
      return { url: `${root}/v1/messages`, headers, body: JSON.stringify(b) };
    },
    fetchImpl,
  );
}

export function bedrockProvider({ region, accessKeyId, secretAccessKey, sessionToken, model, fetchImpl } = {}) {
  if (!region) throw new ConfigError('Amazon Bedrock needs AWS_REGION (for example us-east-1). aws-actions/configure-aws-credentials sets it.');
  if (!REGION.test(region)) throw new ConfigError(`AWS_REGION "${String(region).slice(0, 40)}" is not an AWS region name like us-east-1.`);
  if (!accessKeyId || !secretAccessKey) throw new ConfigError('Amazon Bedrock needs AWS credentials: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (and AWS_SESSION_TOKEN for temporary ones). In GitHub Actions, aws-actions/configure-aws-credentials with OIDC sets them.');
  const host = BEDROCK_MANTLE_HOST(region);
  const modelId = model.startsWith('anthropic.') ? model : `anthropic.${model}`;
  return make(
    { name: 'bedrock', label: 'Amazon Bedrock', where: region, model: modelId, credentialHint: 'Check the AWS credentials and that the role may call Bedrock in this region.' },
    (body, date) => {
      const payload = JSON.stringify({ ...body, model: modelId });
      const payloadHash = sha256hex(payload);
      const amzDate = toAmzDate(date);
      const headers = { host, 'content-type': 'application/json', 'anthropic-version': ANTHROPIC_VERSION, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash };
      if (sessionToken) headers['x-amz-security-token'] = sessionToken;
      const { authorization } = signV4({ method: 'POST', path: BEDROCK_MANTLE_PATH, headers, payloadHash, accessKeyId, secretAccessKey, region, service: BEDROCK_MANTLE_SIGV4_SERVICE, amzDate });
      const { host: _h, ...sent } = headers; // fetch sets Host itself
      return { url: `https://${host}${BEDROCK_MANTLE_PATH}`, headers: { ...sent, authorization }, body: payload };
    },
    fetchImpl,
  );
}

export const vertexHost = (region) => (region === 'global' ? 'aiplatform.googleapis.com' : `${region}-aiplatform.googleapis.com`);

export function vertexProvider({ project, region = 'global', accessToken, model, fetchImpl } = {}) {
  if (!project) throw new ConfigError('Google Vertex AI needs GOOGLE_CLOUD_PROJECT, the id of your Google Cloud project.');
  if (!PROJECT.test(project)) throw new ConfigError(`GOOGLE_CLOUD_PROJECT "${String(project).slice(0, 40)}" is not a Google Cloud project id.`);
  if (!VERTEX_REGION.test(region)) throw new ConfigError(`GOOGLE_CLOUD_REGION "${String(region).slice(0, 40)}" is not a Vertex AI region (use "global", or one like us-east5).`);
  if (!accessToken) throw new ConfigError('Google Vertex AI needs GOOGLE_OAUTH_ACCESS_TOKEN. In GitHub Actions, google-github-actions/auth with token_format: access_token provides it.');
  if (!/^[A-Za-z0-9._@\-]+$/.test(model)) throw new ConfigError(`"${model}" is not a model id Vertex AI accepts.`);
  const url = `https://${vertexHost(region)}/v1/projects/${project}/locations/${region}/publishers/anthropic/models/${model}:rawPredict`;
  return make(
    { name: 'vertex', label: 'Google Vertex AI', where: `project ${project}, region ${region}`, model, credentialHint: 'Check GOOGLE_OAUTH_ACCESS_TOKEN (it expires after an hour) and that the account may use Claude in this project.' },
    (body) => {
      const { model: _m, ...rest } = body;
      return { url, headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` }, body: JSON.stringify({ ...rest, anthropic_version: VERTEX_VERSION }) };
    },
    fetchImpl,
  );
}

export function foundryProvider({ resource, apiKey, model, fetchImpl } = {}) {
  if (!resource) throw new ConfigError('Microsoft Foundry needs ANTHROPIC_FOUNDRY_RESOURCE, the name of your Foundry resource (the part before .services.ai.azure.com).');
  if (!RESOURCE.test(resource)) throw new ConfigError(`ANTHROPIC_FOUNDRY_RESOURCE "${String(resource).slice(0, 40)}" is not a resource name; give only the name, not the URL.`);
  if (!apiKey) throw new ConfigError('Microsoft Foundry needs ANTHROPIC_FOUNDRY_API_KEY, the key of your Foundry resource.');
  const url = `https://${resource}.services.ai.azure.com/anthropic/v1/messages`;
  return make(
    { name: 'foundry', label: 'Microsoft Foundry', where: `resource ${resource}`, model, credentialHint: 'Check ANTHROPIC_FOUNDRY_API_KEY.' },
    (body) => ({ url, headers: { 'content-type': 'application/json', 'api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION }, body: JSON.stringify(body) }),
    fetchImpl,
  );
}

export const PROVIDERS = Object.freeze(['anthropic', 'bedrock', 'vertex', 'foundry']);

// The provider the environment sets up. GRAPIM_REVIEW_PROVIDER picks one;
// without it, ANTHROPIC_API_KEY means the Anthropic API.
export function providerFromEnv(env = process.env, config = {}, { fetchImpl } = {}) {
  const model = config.model || 'claude-opus-5-5';
  const v = (k) => (typeof env[k] === 'string' && env[k].trim() ? env[k].trim() : null);
  let name = v('GRAPIM_REVIEW_PROVIDER')?.toLowerCase() ?? null;
  if (!name) {
    if (v('ANTHROPIC_API_KEY')) name = 'anthropic';
    else throw new ConfigError('No model provider is set up for Grapim Review. Set ANTHROPIC_API_KEY to use the Anthropic API, or set GRAPIM_REVIEW_PROVIDER to "bedrock", "vertex" or "foundry" together with that provider\'s credentials.');
  }
  switch (name) {
    case 'anthropic':
      return anthropicProvider({ apiKey: v('ANTHROPIC_API_KEY'), model, fetchImpl });
    case 'bedrock':
      return bedrockProvider({ region: v('AWS_REGION') ?? v('AWS_DEFAULT_REGION'), accessKeyId: v('AWS_ACCESS_KEY_ID'), secretAccessKey: v('AWS_SECRET_ACCESS_KEY'), sessionToken: v('AWS_SESSION_TOKEN'), model, fetchImpl });
    case 'vertex':
      return vertexProvider({ project: v('GOOGLE_CLOUD_PROJECT'), region: v('GOOGLE_CLOUD_REGION') ?? 'global', accessToken: v('GOOGLE_OAUTH_ACCESS_TOKEN'), model, fetchImpl });
    case 'foundry':
      return foundryProvider({ resource: v('ANTHROPIC_FOUNDRY_RESOURCE'), apiKey: v('ANTHROPIC_FOUNDRY_API_KEY'), model, fetchImpl });
    default:
      throw new ConfigError(`GRAPIM_REVIEW_PROVIDER is "${name.slice(0, 40)}", which Grapim Review does not know. Use "anthropic", "bedrock", "vertex" or "foundry".`);
  }
}

// "the Anthropic API" / "Amazon Bedrock (us-east-1)" for the summary.
export const describeProvider = (p) => (p.where ? `${p.label} (${p.where})` : p.label);
