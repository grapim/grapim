// The OpenAPI 3.1 document served at /v1/openapi.json. It is built from the
// same route table that registers the /v1 routes (api.js), so a route cannot
// exist without being documented, or the other way round.

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const int = (description, extra = {}) => ({ type: 'integer', description, ...extra });
const nullable = (schema) => ({ ...schema, type: [schema.type, 'null'] });
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const list = (item) => ({
  type: 'object',
  required: ['object', 'data', 'has_more'],
  properties: { object: { const: 'list' }, data: { type: 'array', items: ref(item) }, has_more: { type: 'boolean' } },
});

export const SCHEMAS = {
  Error: {
    type: 'object',
    required: ['error'],
    properties: {
      error: {
        type: 'object',
        required: ['code', 'message', 'request_id'],
        properties: { code: str('A stable, machine-readable code.'), message: str('What went wrong, for a person.'), request_id: str('The Request-Id of the request.') },
      },
    },
  },
  Deleted: {
    type: 'object',
    required: ['id', 'object', 'deleted'],
    properties: { id: str('The id.'), object: str('The kind of object.'), deleted: { const: true } },
  },
  Workspace: {
    type: 'object',
    required: ['id', 'object', 'external_id', 'name', 'metadata', 'livemode', 'created_at', 'url', 'mcp_url', 'fs_url', 'usage'],
    properties: {
      id: str('The workspace id.'),
      object: { const: 'workspace' },
      external_id: nullable(str("The platform's own id for this end customer or session; unique among the platform's live workspaces of the same mode.")),
      name: str('The URL name: lowercase letters, digits and dashes.'),
      metadata: { type: 'object', description: 'Free-form JSON, at most 4 KB.' },
      livemode: { type: 'boolean', description: 'false for a workspace made with a test key.' },
      created_at: int('Unix seconds.'),
      expires_at: nullable(int('Unix seconds. Test workspaces are deleted then (7 days after creation); null for live ones.')),
      url: str('The review desk.', { format: 'uri' }),
      mcp_url: str('MCP over HTTP, for agents with a workspace token.', { format: 'uri' }),
      fs_url: str('The file API, for agents with a workspace token.', { format: 'uri' }),
      usage: {
        type: 'object',
        required: ['bytes', 'writes_30d'],
        properties: { bytes: int('Folder size as last measured.'), writes_30d: int('Recorded changes in the last 30 days.') },
      },
    },
  },
  WorkspaceCreate: {
    type: 'object',
    additionalProperties: false,
    properties: { external_id: str('Your id for the end customer or session.', { maxLength: 255 }), name: str('URL name; generated when absent.', { pattern: '^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$' }), metadata: { type: 'object' } },
  },
  WorkspaceUpdate: {
    type: 'object',
    additionalProperties: false,
    properties: { name: str('New URL name (the address changes).'), metadata: { type: 'object', description: 'Replaces the stored metadata.' } },
  },
  WorkspaceToken: {
    type: 'object',
    required: ['id', 'object', 'token', 'scope', 'name', 'agent_name', 'expires_at'],
    properties: {
      id: str('Use it to revoke the token.'),
      object: { const: 'workspace_token' },
      token: str('gws_..., shown once.'),
      scope: { enum: ['read', 'write'] },
      name: str('The token name: runs are http:<name>/<agent>.'),
      agent_name: nullable(str('When set, every run of this token is http:<name>/<agent_name>, whatever X-Grapim-Agent says.')),
      expires_at: int('Unix seconds.'),
    },
  },
  WorkspaceTokenCreate: {
    type: 'object',
    additionalProperties: false,
    required: ['scope'],
    properties: {
      scope: { enum: ['read', 'write'] },
      ttl_seconds: int('Default 3600, at most 2592000 (30 days).', { minimum: 60, maximum: 2592000 }),
      agent_name: str('Pins the run identity.', { pattern: '^[A-Za-z0-9._-]{1,60}$' }),
      name: str('Token name; generated when absent. Unique in the workspace for good.', { pattern: '^[A-Za-z0-9._-]{1,40}$' }),
    },
  },
  EmbedSession: {
    type: 'object',
    required: ['id', 'object', 'url', 'expires_at', 'mode', 'theme', 'parent_origin'],
    properties: {
      id: str('The embed session id.'),
      object: { const: 'embed_session' },
      url: str('Open once, as the src of an iframe on parent_origin, before expires_at.', { format: 'uri' }),
      expires_at: int('Unix seconds. The cookie the link sets then lasts ttl_seconds.'),
      mode: { enum: ['review', 'readonly'] },
      theme: { enum: ['light', 'dark', 'system'] },
      parent_origin: str('The origin that may frame the desk and receives its postMessage events.'),
      branding: { type: 'boolean' },
    },
  },
  EmbedSessionCreate: {
    type: 'object',
    additionalProperties: false,
    properties: {
      mode: { enum: ['review', 'readonly'], default: 'review' },
      ttl_seconds: int('Default 600.', { minimum: 60, maximum: 3600 }),
      theme: { enum: ['light', 'dark', 'system'], default: 'system' },
      parent_origin: str('One of embed_allowed_origins; required when there are several.'),
      user: str('Names the reviewer in the ledger: human:embed:<user>.', { pattern: '^[A-Za-z0-9._@+-]{1,64}$' }),
      branding: { type: 'boolean', default: true, description: 'false hides Grapim branding in the desk. Not allowed in test mode.' },
    },
  },
  Run: { type: 'object', description: 'A run as in docs/api.md GET /api/runs.', required: ['run'], properties: { run: str('The run id.') } },
  UndoRequest: {
    type: 'object',
    additionalProperties: false,
    properties: { turn: nullable(int('Undo from this turn on; null for the whole run.')), apply: { type: 'boolean', default: false } },
  },
  UndoPlan: { type: 'object', description: 'The undo plan or result, as in docs/api.md POST /api/runs/:run/undo.', required: ['applied'], properties: { applied: { type: 'boolean' } } },
  UsageRow: {
    type: 'object',
    required: ['workspace_id', 'external_id', 'day', 'writes', 'api_calls', 'storage_byte_days', 'active'],
    properties: {
      workspace_id: nullable(str('null when grouped by day.')),
      external_id: nullable(str('')),
      day: nullable(str('YYYY-MM-DD (UTC); null when grouped by workspace.')),
      writes: int('Recorded changes.'),
      api_calls: int('Requests to the workspace and to /v1 about it.'),
      storage_byte_days: int('The daily storage samples, summed.'),
      active: { type: ['boolean', 'integer'], description: 'Had a write: per row a boolean; grouped by day, the number of active workspaces.' },
    },
  },
  Usage: {
    type: 'object',
    required: ['object', 'data', 'has_more', 'from', 'to'],
    properties: { object: { const: 'list' }, data: { type: 'array', items: ref('UsageRow') }, has_more: { type: 'boolean' }, from: str('First day.'), to: str('Last day.') },
  },
  WebhookEndpoint: {
    type: 'object',
    required: ['id', 'object', 'url', 'events', 'livemode', 'status', 'created_at'],
    properties: {
      id: str('The endpoint id.'),
      object: { const: 'webhook_endpoint' },
      url: str('https only.', { format: 'uri' }),
      events: { type: 'array', items: { type: 'string' } },
      livemode: { type: 'boolean' },
      status: { enum: ['enabled', 'disabled'] },
      disabled_reason: nullable(str('Why it was disabled.')),
      created_at: int('Unix seconds.'),
      secret: str('whsec_..., only in the reply to its creation.'),
    },
  },
  WebhookEndpointCreate: {
    type: 'object',
    additionalProperties: false,
    required: ['url', 'events'],
    properties: { url: str('https URL on a public address.'), events: { type: 'array', items: { type: 'string' }, description: 'Event types, or ["*"].' } },
  },
  Settings: {
    type: 'object',
    description: "The settings of the calling key's mode: test and live keys each have their own.",
    required: ['object', 'livemode', 'embed_allowed_origins', 'workspace_storage_mb'],
    properties: {
      object: { const: 'platform_settings' },
      livemode: { type: 'boolean' },
      embed_allowed_origins: { type: 'array', items: { type: 'string' } },
      workspace_storage_mb: int("Each workspace's storage limit in MB (files, history and stored versions). Default 512."),
    },
  },
  SettingsUpdate: {
    type: 'object',
    additionalProperties: false,
    description: "Changes only the calling key's mode. At least one field.",
    properties: {
      embed_allowed_origins: { type: 'array', items: { type: 'string' }, maxItems: 20, description: 'https origins (http only for localhost).' },
      workspace_storage_mb: { type: 'integer', minimum: 1, description: "Each workspace's storage limit in MB, up to the platform's own quota." },
    },
  },
  WorkspaceList: list('Workspace'),
  RunList: list('Run'),
  WebhookEndpointList: list('WebhookEndpoint'),
};

const PARAMS = {
  limit: { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
  starting_after: { name: 'starting_after', in: 'query', schema: { type: 'string' }, description: 'The id of the last item of the previous page.' },
  external_id: { name: 'external_id', in: 'query', schema: { type: 'string' } },
  from: { name: 'from', in: 'query', schema: { type: 'string', format: 'date' }, description: 'Default: the first day of this month (UTC).' },
  to: { name: 'to', in: 'query', schema: { type: 'string', format: 'date' }, description: 'Default: today (UTC). At most 93 days after from.' },
  group_by: { name: 'group_by', in: 'query', schema: { enum: ['workspace', 'day'] } },
  usage_limit: { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 1000, default: 100 } },
};

const pathParam = (name) => ({ name, in: 'path', required: true, schema: { type: 'string' } });
const errorResponse = { description: 'An error.', content: { 'application/json': { schema: ref('Error') } } };

export function buildOpenApi(routes, origin) {
  const paths = {};
  for (const r of routes) {
    const p = r.path.replace(/:(\w+)/g, '{$1}');
    const params = [...r.path.matchAll(/:(\w+)/g)].map((m) => pathParam(m[1]));
    for (const q of r.query ?? []) params.push(PARAMS[q]);
    if (r.method === 'POST' && !r.public) params.push({ name: 'Idempotency-Key', in: 'header', schema: { type: 'string', maxLength: 255 }, description: 'The same key and body within 24 h returns the stored response; a different body is 409 idempotency_mismatch.' });
    const op = {
      operationId: r.op,
      summary: r.summary,
      ...(r.public ? { security: [] } : {}),
      ...(params.length ? { parameters: params } : {}),
      ...(r.body ? { requestBody: { required: !!r.bodyRequired, content: { 'application/json': { schema: ref(r.body) } } } } : {}),
      responses: {
        200: { description: 'OK', headers: { 'Request-Id': { schema: { type: 'string' } } }, content: { 'application/json': { schema: r.response ? ref(r.response) : { type: 'object' } } } },
        ...(r.public ? {} : { 400: errorResponse, 401: errorResponse, 404: errorResponse, 409: errorResponse, 429: errorResponse }),
      },
    };
    (paths[p] ??= {})[r.method.toLowerCase()] = op;
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Grapim platform API',
      version: '2026-11-11',
      description:
        'Recorded, reviewable, undoable workspaces for every end customer of an agent platform. JSON in and out; errors are { error: { code, message, request_id } }; every response has a Request-Id header; lists use ?limit= and ?starting_after=. See docs/platform.md.',
    },
    servers: [{ url: origin }],
    security: [{ platformKey: [] }],
    components: {
      securitySchemes: { platformKey: { type: 'http', scheme: 'bearer', description: 'gpk_live_... or gpk_test_..., created by a platform owner in the hub.' } },
      schemas: SCHEMAS,
    },
    paths,
  };
}
