// Types for @grapim/sdk. Request and response bodies keep the API's own
// snake_case field names (docs/platform.md); SDK options are camelCase.

export declare const VERSION: string;

// ---------------------------------------------------------------- options

export interface ClientOptions {
  /** A `gpk_live_…` or `gpk_test_…` platform key. Defaults to env `GRAPIM_API_KEY`. */
  apiKey?: string;
  /** Default `https://app.grapim.com`. A trailing `/v1` is accepted. */
  baseUrl?: string;
  /** A fetch implementation; defaults to the global one. */
  fetch?: typeof fetch;
  /** Total attempts per request, the first included. Default 3. */
  maxAttempts?: number;
  /** First backoff step when the server sends no Retry-After. Default 500 ms. */
  baseDelayMs?: number;
  /** Backoff cap. Default 8000 ms. */
  maxDelayMs?: number;
  /** The longest Retry-After honoured. Default 60000 ms. */
  maxRetryAfterMs?: number;
  /** Per attempt. Default 60000 ms. */
  timeoutMs?: number;
  /** Extra headers on every request. */
  headers?: Record<string, string>;
  /** Allow a platform key in a browser. A platform key acts for the whole platform: do not. */
  dangerouslyAllowBrowser?: boolean;
}

export interface RequestOptions {
  signal?: AbortSignal;
  /** Overrides the generated Idempotency-Key (POSTs only). The same key with the same body within 24 h returns the stored response. */
  idempotencyKey?: string;
}

export interface WorkspaceClientOptions extends Omit<ClientOptions, 'apiKey' | 'baseUrl' | 'dangerouslyAllowBrowser'> {
  /** The workspace URL: `url`, `fs_url` or `mcp_url` from the API. */
  url: string;
  /** A `gws_` workspace token. */
  token: string;
  /** Sent as `X-Grapim-Agent`: the run id becomes `http:<token-name>/<agent>`. Printable ASCII. */
  agent?: string;
  /** Sent as `X-Grapim-Intent` on writes; a new intent starts a new turn. Printable ASCII. */
  intent?: string;
}

// ---------------------------------------------------------------- objects

export type Metadata = Record<string, unknown>;

export interface Workspace {
  id: string;
  object: 'workspace';
  external_id: string | null;
  name: string;
  metadata: Metadata | null;
  created_at: number | string;
  url: string;
  mcp_url: string;
  fs_url: string;
  usage?: { bytes: number; writes_30d: number };
  /** Test-mode workspaces are deleted 7 days after creation; null in live mode. */
  expires_at?: number | null;
}

export interface Page<T> {
  data: T[];
  has_more: boolean;
}

export interface ListParams {
  limit?: number;
  starting_after?: string;
}

/** Folders to start a workspace with, each with a short README.md, written as the approved run `template:<name>`. */
export type WorkspaceTemplate = 'blank' | 'agent-team' | 'research' | 'data';

export interface WorkspaceCreateParams {
  external_id?: string;
  name?: string;
  /** JSON, up to 4 KB. */
  metadata?: Metadata;
  /** Default `blank`. agent-team: code/, docs/, data/, saas/; research: sources/, notes/, drafts/; data: raw/, clean/, reports/. */
  template?: WorkspaceTemplate;
}

export interface WorkspaceUpdateParams {
  name?: string;
  metadata?: Metadata;
}

export interface WorkspaceListParams extends ListParams {
  external_id?: string;
}

export type TokenScope = 'read' | 'write';

/**
 * One folder rule of a workspace token. `path` is a workspace-relative glob
 * (`docs/**`, `notes/*.md`; a trailing `/` means the whole folder). Every rule
 * grants read; write needs the most specific covering rule (longest literal
 * prefix, then write over read) to be `write`.
 */
export interface ScopeRule {
  path: string;
  access: TokenScope;
}

export interface TokenCreateParams {
  scope: TokenScope;
  /** Default 3600, maximum 30 days. */
  ttl_seconds?: number;
  /** Pins the run identity to `http:<token-name>/<agent_name>`. */
  agent_name?: string;
  /** Token name; generated when absent. */
  name?: string;
  /**
   * Limit the token to some folders (at most 32 rules). Outside them, reads
   * are 404 and writes 403. A read token cannot have write rules. Absent or
   * empty: the whole workspace.
   */
  scopes?: ScopeRule[];
}

export interface WorkspaceToken {
  /** The `gws_` token, shown once. */
  token: string;
  expires_at: number | string;
  scope: TokenScope;
  /** The folder rules, or null for the whole workspace. */
  scopes?: ScopeRule[] | null;
  /** The token's id, for tokens.revoke, when the server returns it. */
  id?: string;
  [k: string]: unknown;
}

export interface EmbedSessionCreateParams {
  mode: 'review' | 'readonly';
  /** Default 600, maximum 3600. */
  ttl_seconds?: number;
  theme?: 'light' | 'dark' | 'system';
}

export interface EmbedSession {
  url: string;
  expires_at: number | string;
}

export interface Review {
  status: 'pending' | 'approved' | 'rejected';
  note: string | null;
  at: number | null;
  by: string | null;
}

export interface Run {
  run: string;
  label: string;
  worktree: string;
  intent: string | null;
  turns: number;
  files: number;
  added: number;
  removed: number;
  in_tree: 'all' | 'some' | 'none' | null;
  first_ts: number;
  last_ts: number;
  active: boolean;
  review: Review;
  branch: string | null;
}

export interface HunkLine { t: ' ' | '+' | '-'; s: string }
export interface Hunk { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: HunkLine[] }

export interface RunDetail {
  run: Run;
  turns: { turn: number; intent: string | null; ts: number; files: string[] }[];
  files: {
    path: string;
    added: number | null;
    removed: number | null;
    untracked: boolean;
    state: 'in_tree' | 'gone' | 'partial' | null;
    diff: { hunks: Hunk[] } | null;
  }[];
}

export interface UndoParams {
  /** One turn of the run; omit for the whole run. */
  turn?: number | null;
  /** false (default): return the plan; true: apply it. */
  apply?: boolean;
}

export interface UndoResult {
  applied: boolean;
  run: string;
  label: string;
  turn: number | null;
  files: { path: string; root: string; action: string; reason: string | null }[];
}

export interface UsageParams {
  /** A Date becomes YYYY-MM-DD (UTC); strings and numbers are sent as given. */
  from?: Date | string | number;
  to?: Date | string | number;
  group_by?: 'workspace' | 'day';
}

export interface UsageRow {
  workspace_id: string;
  external_id: string | null;
  day: string;
  writes: number;
  api_calls: number;
  storage_byte_days: number;
  active: boolean;
}

export type WebhookEventType =
  | 'workspace.created'
  | 'workspace.deleted'
  | 'run.started'
  | 'run.updated'
  | 'run.reviewed'
  | 'run.undone'
  | 'edit.blocked'
  | 'file.restored';

export interface WebhookEndpointCreateParams {
  /** https only. */
  url: string;
  events: WebhookEventType[];
}

export interface WebhookEndpoint {
  id: string;
  url?: string;
  events?: WebhookEventType[];
  /** Only in the create response, shown once. */
  secret?: string;
  [k: string]: unknown;
}

export interface WebhookEvent<D = Record<string, unknown>> {
  id: string;
  type: WebhookEventType | string;
  created: number;
  workspace: { id: string; external_id: string | null };
  data: D;
}

/** Settings are per key mode: a test key reads and writes test settings only. */
export interface SettingsUpdateParams {
  embed_allowed_origins?: string[];
  /** Storage limit per workspace in MB (default 512). */
  workspace_storage_mb?: number;
  /**
   * Keep the platform's workspace files in your own bucket (live keys only;
   * a test key gets 403 livemode_required). null: back to the hub's storage.
   */
  storage?: StorageUpdateParams | null;
}

export type StorageProvider = 's3' | 'r2' | 'gcs' | 'azure';

/**
 * Your own bucket. Grapim writes, reads, lists and deletes a test object
 * before saving (400 storage_unreachable otherwise), then copies the files in
 * the background and switches when the copy completes. Credentials are write
 * only: they are never returned.
 */
export type StorageUpdateParams =
  | { provider: 's3'; bucket: string; prefix?: string; region?: string; endpoint?: string; access_key_id: string; secret_access_key: string }
  | { provider: 'r2'; bucket: string; prefix?: string; endpoint: string; access_key_id: string; secret_access_key: string }
  | { provider: 'gcs'; bucket: string; prefix?: string; endpoint?: string; /** A GCS HMAC key. */ access_key_id: string; secret_access_key: string }
  | { provider: 'azure'; account: string; /** The container. */ bucket: string; prefix?: string; endpoint?: string; account_key: string }
  | { provider: 'hub' };

/** In GET/PUT /v1/settings with a live key, when the hub has workspace storage. */
export interface StorageSettings {
  object: 'storage';
  provider: 'hub' | StorageProvider;
  bucket: string | null;
  prefix: string | null;
  endpoint: string | null;
  region: string | null;
  account: string | null;
  credentials: 'saved' | 'unreadable' | null;
  move: {
    state: 'copying' | 'failed';
    to: 'hub' | StorageProvider;
    bucket?: string;
    prefix?: string;
    endpoint?: string;
    done: number;
    total: number;
    copied: number;
    pass: number;
    error: string | null;
  } | null;
}

export interface Settings {
  object: 'platform_settings';
  livemode: boolean;
  embed_allowed_origins: string[];
  workspace_storage_mb: number;
  storage?: StorageSettings;
}

export interface Deleted {
  id?: string;
  deleted?: boolean;
  [k: string]: unknown;
}

// ---------------------------------------------------------------- workspace files

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size: number;
  last_change: { ts: number; label: string; run: string } | null;
  held_by: string | null;
}

export interface WriteResult {
  path: string;
  sha: string | null;
  added: number | null;
  removed: number | null;
}

export interface WriteOptions {
  /** A sha from read or write: the file must still be that version. "absent" or null: the file must not exist. */
  ifMatch?: string | null;
  /** Overrides the client's intent for this write. */
  intent?: string;
  signal?: AbortSignal;
}

export interface BlameLine {
  line: number;
  text: string;
  run?: string | null;
  label?: string | null;
  turn?: number | null;
  ts?: number | null;
  [k: string]: unknown;
}

export interface Blame {
  path: string;
  base: string;
  changes: number;
  exists: boolean;
  untracked: boolean;
  lines?: BlameLine[];
  removed?: number;
  runs?: string[];
  /** Only with `full: true`. */
  content?: string | null;
}

export interface ReleaseResult {
  released: string[];
  recorded: { path: string; detail: string }[];
}

export declare class WorkspaceClient {
  constructor(options: WorkspaceClientOptions);
  /** The workspace root URL, with a trailing slash. */
  readonly url: string;
  read(path: string, options?: { signal?: AbortSignal }): Promise<{ content: Uint8Array; sha: string | null }>;
  readText(path: string, options?: { signal?: AbortSignal }): Promise<{ text: string; sha: string | null }>;
  write(path: string, content: string | Uint8Array | ArrayBuffer | ArrayBufferView, options?: WriteOptions): Promise<WriteResult>;
  delete(path: string, options?: WriteOptions): Promise<WriteResult>;
  list(dir?: string, options?: { recursive?: false; signal?: AbortSignal }): Promise<FileEntry[]>;
  list(dir: string, options: { recursive: true; signal?: AbortSignal }): Promise<{ files: FileEntry[]; truncated: boolean }>;
  blame(path: string, options?: { full?: boolean; signal?: AbortSignal }): Promise<Blame>;
  runs(options?: { signal?: AbortSignal }): Promise<Run[]>;
  run(run: string, options?: { signal?: AbortSignal }): Promise<RunDetail>;
  undo(run: string, options?: UndoParams & { signal?: AbortSignal }): Promise<UndoResult>;
  release(options?: { signal?: AbortSignal }): Promise<ReleaseResult>;
}

// ---------------------------------------------------------------- client

/** Awaitable as the first page; async-iterable across every page. */
export declare class ListResult<T> implements PromiseLike<Page<T>>, AsyncIterable<T> {
  firstPage(): Promise<Page<T>>;
  then<A = Page<T>, B = never>(
    onFulfilled?: ((value: Page<T>) => A | PromiseLike<A>) | null,
    onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B>;
  catch<B = never>(onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null): Promise<Page<T> | B>;
  [Symbol.asyncIterator](): AsyncIterator<T>;
  toArray(options?: { max?: number }): Promise<T[]>;
}

export declare class Grapim {
  constructor(options?: ClientOptions);
  /** A file client for an agent holding a `gws_` workspace token. */
  static workspace(options: WorkspaceClientOptions): WorkspaceClient;
  readonly baseUrl: string;
  /** True for a `gpk_test_` key. */
  readonly testMode: boolean;

  workspaces: {
    create(params?: WorkspaceCreateParams, options?: RequestOptions): Promise<Workspace>;
    list(params?: WorkspaceListParams, options?: { signal?: AbortSignal }): ListResult<Workspace>;
    get(id: string, options?: RequestOptions): Promise<Workspace>;
    update(id: string, params: WorkspaceUpdateParams, options?: RequestOptions): Promise<Workspace>;
    delete(id: string, options?: RequestOptions): Promise<Deleted>;
  };
  tokens: {
    create(workspaceId: string, params: TokenCreateParams, options?: RequestOptions): Promise<WorkspaceToken>;
    revoke(workspaceId: string, tokenId: string, options?: RequestOptions): Promise<Deleted>;
  };
  embedSessions: {
    create(workspaceId: string, params: EmbedSessionCreateParams, options?: RequestOptions): Promise<EmbedSession>;
  };
  runs: {
    list(workspaceId: string, options?: RequestOptions): Promise<Run[]>;
    undo(workspaceId: string, run: string, params?: UndoParams, options?: RequestOptions): Promise<UndoResult>;
  };
  usage: {
    get(params?: UsageParams, options?: RequestOptions): Promise<{ data: UsageRow[] }>;
  };
  webhooks: {
    create(params: WebhookEndpointCreateParams, options?: RequestOptions): Promise<WebhookEndpoint & { secret: string }>;
    list(params?: ListParams, options?: { signal?: AbortSignal }): ListResult<WebhookEndpoint>;
    delete(id: string, options?: RequestOptions): Promise<Deleted>;
  };
  settings: {
    update(params: SettingsUpdateParams, options?: RequestOptions): Promise<Settings>;
  };
}
export default Grapim;

// ---------------------------------------------------------------- webhooks

/**
 * Verifies `Grapim-Signature: t=<unix>,v1=<hex hmac-sha256 of "t.body">` and returns the parsed event.
 * Pass the raw body exactly as received. Throws WebhookSignatureError otherwise.
 */
export declare function verifyWebhook<D = Record<string, unknown>>(
  rawBody: string | Uint8Array | ArrayBuffer | ArrayBufferView,
  header: string | string[] | null | undefined,
  secret: string,
  options?: { tolerance?: number; now?: number },
): Promise<WebhookEvent<D>>;

// ---------------------------------------------------------------- errors

export declare class GrapimError extends Error {
  /** The API's error code, e.g. `not_found`, `idempotency_mismatch`, `precondition_failed`. */
  code: string;
  /** HTTP status; 0 when no response arrived. */
  status: number;
  /** The Request-Id of the failed response, when there was one. */
  requestId: string | null;
  /** On a 412 from a conditional write: the file's sha now, null when absent. */
  currentSha?: string | null;
  /** The parsed error body. */
  readonly body?: unknown;
}
export declare class AuthenticationError extends GrapimError {}
export declare class PermissionDeniedError extends GrapimError {}
export declare class NotFoundError extends GrapimError {}
export declare class ConflictError extends GrapimError {}
export declare class PreconditionFailedError extends GrapimError {
  currentSha: string | null;
}
export declare class RateLimitError extends GrapimError {}
export declare class ConnectionError extends GrapimError {}
export declare class WebhookSignatureError extends GrapimError {}
