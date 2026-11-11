// Builds the mock-mode fixtures for the review desk from one scripted story,
// so every fixture agrees with every other: run diffs, blame, file history,
// stored versions, the event log and the undo plans all come from the same
// replayed edits. Run it from anywhere: `node ui/fixtures/_generate.mjs`.
//
// The story: shop-api, a small TypeScript store API. Four agents are working
// now (two Claude Code sessions, Codex, and an agent in an E2B sandbox that
// writes through /fs). Three earlier runs have ended: one approved and put on
// a branch, one rejected and undone, one waiting whose undo plan has a conflict.

import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.dirname(fileURLToPath(import.meta.url));
const GEN = Date.UTC(2026, 10, 11, 9, 30, 0); // fixtures are shifted to "now" at load time
const min = (m) => GEN - Math.round(m * 60_000);

// String.raw keeps TypeScript's own `${…}` and backticks when written as $\{ and \`.
const src = (s, ...v) => String.raw(s, ...v).replaceAll('\\`', '`').replaceAll('$\\{', '${').replace(/^\n/, '');
const sha1 = (s) => (s === null ? null : createHash('sha1').update(s).digest('hex'));

function edit(...pairs) {
  return (s) => {
    let out = s;
    for (let i = 0; i < pairs.length; i += 2) {
      if (!out.includes(pairs[i])) throw new Error(`edit target not found: ${pairs[i].slice(0, 60)}`);
      out = out.replace(pairs[i], pairs[i + 1]);
    }
    return out;
  };
}

// ---------------------------------------------------------------- HEAD files

const MAIN = 'shop-api';
const HDR = 'shop-api-header';

const HEAD = {
  'src/server.ts': src`
import { createServer } from 'node:http';
import { createApp } from './app';
import { routes } from './routes';
import { logger } from './log';
import { loadConfig } from './config';

const config = loadConfig(process.env);
const app = createApp(config);

app.use(async (ctx, next) => {
  const started = performance.now();
  await next();
  const ms = Math.round(performance.now() - started);
  logger.info(\`$\{ctx.method} $\{ctx.path} $\{ctx.status} $\{ms}ms\`);
});

app.use(routes);

const port = Number(process.env.PORT ?? 3000);

createServer(app.callback()).listen(port, () => {
  logger.info(\`shop-api listening on :$\{port}\`);
});
`,
  'src/log.ts': src`
type Level = 'debug' | 'info' | 'warn' | 'error';
type Fields = Record<string, unknown>;

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = order[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? order.info;

function write(level: Level, message: string, fields: Fields = {}) {
  if (order[level] < threshold) return;
  const line = { t: new Date().toISOString(), level, message, ...fields };
  process.stdout.write(JSON.stringify(line) + '\n');
}

export const logger = {
  debug: (m: string, f?: Fields) => write('debug', m, f),
  info: (m: string, f?: Fields) => write('info', m, f),
  warn: (m: string, f?: Fields) => write('warn', m, f),
  error: (m: string, f?: Fields) => write('error', m, f),
};
`,
  'src/types.ts': src`
export interface Context {
  method: string;
  path: string;
  status: number;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  state: Record<string, unknown>;
}

export type Next = () => Promise<void>;
export type Middleware = (ctx: Context, next: Next) => Promise<void>;

export interface Money {
  amount: number; // minor units
  currency: 'USD' | 'EUR' | 'TWD';
}
`,
  'src/routes.ts': src`
import { Router } from './router';
import { getProduct, listProducts } from './products';
import { addToCart, getCart } from './checkout/cart';

export const routes = new Router();

routes.get('/health', async (ctx) => {
  ctx.body = { ok: true };
});

routes.get('/products', async (ctx) => {
  ctx.body = await listProducts({ limit: Number(ctx.query.get('limit') ?? 20) });
});

routes.get('/products/:id', async (ctx) => {
  const product = await getProduct(ctx.params.id);
  if (!product) {
    ctx.status = 404;
    ctx.body = { error: 'not_found' };
    return;
  }
  ctx.body = product;
});

routes.get('/cart/:id', async (ctx) => {
  ctx.body = await getCart(ctx.params.id);
});

routes.post('/cart/:id/items', async (ctx) => {
  ctx.body = await addToCart(ctx.params.id, ctx.body as { sku: string; qty: number });
  ctx.status = 201;
});
`,
  'src/checkout/cart.ts': src`
import { getProduct } from '../products';
import type { Money } from '../types';

export interface CartItem {
  sku: string;
  qty: number;
  price: Money;
}

export interface Cart {
  id: string;
  items: CartItem[];
  total: Money;
}

const carts = new Map<string, Cart>();

export function resetCarts() {
  carts.clear();
}

export async function getCart(id: string): Promise<Cart> {
  const cart = carts.get(id) ?? { id, items: [], total: { amount: 0, currency: 'USD' } };
  return JSON.parse(JSON.stringify(cart));
}

export async function addToCart(id: string, item: { sku: string; qty: number }): Promise<Cart> {
  const product = await getProduct(item.sku);
  if (!product) throw new Error(\`Unknown sku $\{item.sku}\`);
  const cart = carts.get(id) ?? { id, items: [], total: { amount: 0, currency: 'USD' } };
  cart.items.push({ sku: item.sku, qty: item.qty, price: product.price });
  cart.total = {
    amount: cart.items.reduce((sum, i) => sum + i.price.amount * i.qty, 0),
    currency: 'USD',
  };
  carts.set(id, cart);
  return cart;
}
`,
  'test/cart.test.ts': src`
import { describe, it, expect, beforeEach } from 'vitest';
import { addToCart, getCart, resetCarts } from '../src/checkout/cart';

describe('cart', () => {
  beforeEach(() => resetCarts());

  it('adds an item and totals it', async () => {
    const cart = await addToCart('a', { sku: 'tee-black-m', qty: 2 });
    expect(cart.total.amount).toBe(5800);
  });

  it('returns a copy, not the stored cart', async () => {
    await addToCart('b', { sku: 'mug-white', qty: 1 });
    const cart = await getCart('b');
    cart.items.length = 0;
    expect((await getCart('b')).items).toHaveLength(1);
  });
});
`,
  'src/products.ts': src`
import { db } from './db';
import type { Money } from './types';

export interface Product {
  sku: string;
  name: string;
  price: Money;
  stock: number;
}

export async function getProduct(sku: string): Promise<Product | undefined> {
  const row = await db.one('select * from products where sku = $1', [sku]);
  return row ? toProduct(row) : undefined;
}

export async function listProducts({ limit = 20 } = {}): Promise<Product[]> {
  const rows = await db.many('select * from products order by name limit $1', [limit]);
  return rows.map(toProduct);
}

function toProduct(row: Record<string, unknown>): Product {
  return {
    sku: String(row.sku),
    name: String(row.name),
    price: { amount: Number(row.price_cents), currency: 'USD' },
    stock: Number(row.stock),
  };
}
`,
  'src/schema.ts': src`
import { z } from 'zod';

export const AddItem = z.object({
  sku: z.string().min(1),
  qty: z.number().int().positive().max(99),
});

export const CreateInvoice = z.object({
  cartId: z.string().uuid(),
});

export function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const first = result.error.errors[0];
    throw Object.assign(new Error(\`$\{first.path.join('.')}: $\{first.message}\`), { status: 400 });
  }
  return result.data;
}
`,
  'package.json': src`
{
  "name": "shop-api",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "redis": "^4.7.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "tsx": "^4.19.2",
    "typescript": "^5.6.3",
    "vitest": "^2.1.4"
  }
}
`,
  'src/app.ts': src`
import type { Config } from './config';
import type { Middleware } from './types';

export function createApp(config: Config) {
  const stack: Middleware[] = [];
  return {
    config,
    use(mw: Middleware | { middleware(): Middleware }) {
      stack.push('middleware' in mw ? mw.middleware() : mw);
    },
    callback() {
      return compose(stack);
    },
  };
}

function compose(stack: Middleware[]) {
  return (req: unknown, res: unknown) => {
    // Adapts node:http to Context and runs the stack in order.
    void req;
    void res;
    void stack;
  };
}
`,
  'src/config.ts': src`
export interface Config {
  databaseUrl: string;
  redisUrl?: string;
  env: 'development' | 'test' | 'production';
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  return {
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    env: (env.NODE_ENV as Config['env']) ?? 'development',
  };
}
`,
  'src/db.ts': src`
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export const db = {
  async one(sql: string, params: unknown[] = []) {
    const { rows } = await pool.query(sql, params);
    return rows[0] ?? null;
  },
  async many(sql: string, params: unknown[] = []) {
    const { rows } = await pool.query(sql, params);
    return rows;
  },
};
`,
  'src/router.ts': src`
import type { Context, Middleware } from './types';

type Handler = (ctx: Context) => Promise<void>;

export class Router {
  #routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler }[] = [];

  get(path: string, handler: Handler) {
    this.#add('GET', path, handler);
  }

  post(path: string, handler: Handler) {
    this.#add('POST', path, handler);
  }

  #add(method: string, path: string, handler: Handler) {
    const keys: string[] = [];
    const pattern = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
    this.#routes.push({ method, pattern, keys, handler });
  }

  middleware(): Middleware {
    return async (ctx, next) => {
      for (const r of this.#routes) {
        const m = r.method === ctx.method && r.pattern.exec(ctx.path);
        if (!m) continue;
        r.keys.forEach((k, i) => (ctx.params[k] = decodeURIComponent(m[i + 1])));
        return r.handler(ctx);
      }
      await next();
    };
  }
}
`,
  'README.md': src`
# shop-api

The store API behind shop.example. Node 22, TypeScript, Postgres.

    npm install
    npm run dev

Tests: \`npm test\`. Type check: \`npm run typecheck\`.
`,
  'tsconfig.json': src`
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src", "test"]
}
`,
};

// The header worktree has the web app too.
const HEAD_HDR = {
  'web/Header.tsx': src`
import { useState } from 'react';
import { CartButton } from './CartButton';
import './header.css';

export function Header({ cartCount }: { cartCount: number }) {
  const [open, setOpen] = useState(false);
  return (
    <header className="header">
      <a className="header__logo" href="/">Shop</a>
      <nav className="header__nav">
        <a href="/new">New</a>
        <a href="/men">Men</a>
        <a href="/women">Women</a>
        <a href="/sale">Sale</a>
      </nav>
      <CartButton count={cartCount} />
    </header>
  );
}
`,
  'web/header.css': src`
.header {
  display: flex;
  align-items: center;
  gap: 24px;
  padding: 16px 32px;
}

.header__nav {
  display: flex;
  gap: 16px;
}
`,
};

// ---------------------------------------------------------------- agents and runs

const RUNS = {
  r1: { run: 'claude-code:1a2b3c4d-6e0f-4b7a-9d21-58c3e0a4f911', label: 'claude 1a2b3c4d', worktree: MAIN, active: true },
  r2: { run: 'mcp:codex-4121', label: 'codex 4121', worktree: MAIN, active: true },
  r3: { run: 'claude-code:9f8e7d6c-2b1a-4e3d-8c7b-0a9f8e7d6c5b', label: 'claude 9f8e7d6c', worktree: HDR, active: true },
  r4: { run: 'http:e2b-5d0c', label: 'e2b-5d0c', worktree: MAIN, active: true },
  r5: { run: 'claude-code:77ab12ef-90cd-4e1f-a2b3-c4d5e6f70812', label: 'claude 77ab12ef', worktree: MAIN, active: false },
  r6: { run: 'mcp:cursor-3e9a', label: 'cursor 3e9a', worktree: MAIN, active: false },
  r7: { run: 'claude-code:0c4d5e6f-1a2b-4c3d-9e8f-7a6b5c4d3e2f', label: 'claude 0c4d5e6f', worktree: MAIN, active: false },
};
const UNDO7 = { run: `undo:${min(118)}`, label: 'undo claude 0c4d5e6f', worktree: MAIN, active: false };
RUNS.u7 = UNDO7; // undo runs are runs too
const OUTSIDE = { run: null, label: 'outside agents', worktree: MAIN };
const OUT_AUTHOR = { run: null, label: "outside agents", turn: null };

// Each step: when, who, which turn, which file, how the content changes.
// `to: null` deletes the file; a string replaces it; a function edits it.
const STEPS = [
  // r7: a Redis cache, later rejected and undone.
  { at: 190, who: 'r7', turn: 1, intent: 'Try a Redis cache for product lookups', file: 'src/cache.ts', to: src`
import { createClient } from 'redis';

const client = createClient({ url: process.env.REDIS_URL });
client.connect().catch(() => {});

export function cached<A extends string, R>(prefix: string, fn: (arg: A) => Promise<R>) {
  return async (arg: A): Promise<R> => {
    const key = \`$\{prefix}:$\{arg}\`;
    const hit = await client.get(key).catch(() => null);
    if (hit) return JSON.parse(hit) as R;
    const value = await fn(arg);
    await client.set(key, JSON.stringify(value)).catch(() => {});
    return value;
  };
}
` },
  { at: 188, who: 'r7', turn: 1, file: 'src/products.ts', to: edit(
    "import { db } from './db';\n", "import { cached } from './cache';\nimport { db } from './db';\n",
    'export async function getProduct(sku: string): Promise<Product | undefined> {', 'export const getProduct = cached(\'product\', async (sku: string): Promise<Product | undefined> => {',
    '  return row ? toProduct(row) : undefined;\n}', '  return row ? toProduct(row) : undefined;\n});',
  ) },
  { at: 176, who: 'r7', turn: 2, intent: 'Expire cache entries after 60 seconds', file: 'src/cache.ts', to: edit(
    'client.connect().catch(() => {});\n', 'client.connect().catch(() => {});\n\nconst TTL_SECONDS = 60;\n',
    'await client.set(key, JSON.stringify(value)).catch(() => {});', 'await client.set(key, JSON.stringify(value), { EX: TTL_SECONDS }).catch(() => {});',
  ) },
  // r6: zod 4.
  { at: 132, who: 'r6', turn: 1, intent: 'Bump zod to v4 and fix the schema errors', file: 'package.json', to: edit('"zod": "^3.23.8"', '"zod": "^4.1.5"') },
  { at: 130, who: 'r6', turn: 1, file: 'src/schema.ts', to: edit(
    'cartId: z.string().uuid(),', 'cartId: z.uuid(),',
    'const first = result.error.errors[0];', 'const first = result.error.issues[0];',
  ) },
  // The human undid r7 (recorded as its own run).
  { at: 118, who: 'u7', turn: 0, file: 'src/cache.ts', to: null },
  { at: 118, who: 'u7', turn: 0, file: 'src/products.ts', to: () => HEAD['src/products.ts'] },
  // r5: request ids, still waiting for review.
  { at: 55, who: 'r5', turn: 1, intent: 'Add a request-id middleware and put the id in every log line', file: 'src/middleware/requestId.ts', to: src`
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Middleware } from '../types';

const store = new AsyncLocalStorage<string>();

/** The id of the request being handled, or undefined outside a request. */
export const currentRequestId = () => store.getStore();

export function requestId(header = 'x-request-id'): Middleware {
  return async (ctx, next) => {
    const incoming = ctx.headers.get(header);
    const id = incoming && incoming.length <= 64 ? incoming : randomUUID();
    ctx.requestId = id;
    await store.run(id, next);
  };
}
` },
  { at: 54, who: 'r5', turn: 1, file: 'src/types.ts', to: edit(
    '  status: number;\n', '  status: number;\n  requestId: string;\n  headers: Headers;\n',
  ) },
  { at: 53, who: 'r5', turn: 1, file: 'src/server.ts', to: edit(
    "import { loadConfig } from './config';\n", "import { loadConfig } from './config';\nimport { requestId } from './middleware/requestId';\n",
    'const app = createApp(config);\n\n', 'const app = createApp(config);\n\napp.use(requestId());\n\n',
    'logger.info(`${ctx.method} ${ctx.path} ${ctx.status} ${ms}ms`);', 'logger.info(`${ctx.method} ${ctx.path} ${ctx.status} ${ms}ms`, { requestId: ctx.requestId });',
  ) },
  { at: 47, who: 'r5', turn: 2, intent: 'Also add the id from inside the logger so callers do not have to', file: 'src/log.ts', to: edit(
    "type Level = 'debug' | 'info' | 'warn' | 'error';\n", "import { currentRequestId } from './middleware/requestId';\n\ntype Level = 'debug' | 'info' | 'warn' | 'error';\n",
    'const line = { t: new Date().toISOString(), level, message, ...fields };', 'const line = { t: new Date().toISOString(), level, message, requestId: currentRequestId(), ...fields };',
  ) },
  // Someone ran sed on the port.
  { at: 31, who: 'out', turn: null, file: 'src/server.ts', to: edit('process.env.PORT ?? 3000', 'process.env.PORT ?? 8080') },
  // r1: billing, active.
  { at: 26, who: 'r1', turn: 1, intent: 'Add a /billing route with tests', file: 'src/billing/invoice.ts', to: src`
import { randomUUID } from 'node:crypto';
import { getCart } from '../checkout/cart';
import type { Money } from '../types';

export interface Invoice {
  id: string;
  cartId: string;
  total: Money;
  status: 'open' | 'paid' | 'void';
  createdAt: string;
}

const invoices = new Map<string, Invoice>();

export async function createInvoice(cartId: string): Promise<Invoice> {
  const cart = await getCart(cartId);
  if (cart.items.length === 0) throw new Error('Cannot invoice an empty cart');
  const invoice: Invoice = {
    id: \`inv_$\{randomUUID().slice(0, 12)}\`,
    cartId,
    total: cart.total,
    status: 'open',
    createdAt: new Date().toISOString(),
  };
  invoices.set(invoice.id, invoice);
  return invoice;
}

export async function getInvoice(id: string): Promise<Invoice | undefined> {
  return invoices.get(id);
}
` },
  { at: 25, who: 'r1', turn: 1, file: 'src/routes.ts', to: edit(
    "import { addToCart, getCart } from './checkout/cart';\n", "import { addToCart, getCart } from './checkout/cart';\nimport { createInvoice, getInvoice } from './billing/invoice';\n",
    '  ctx.status = 201;\n});\n', src`
  ctx.status = 201;
});

routes.post('/billing/invoices', async (ctx) => {
  const { cartId } = ctx.body as { cartId: string };
  const invoice = await createInvoice(cartId);
  ctx.status = 201;
  ctx.body = invoice;
});

routes.get('/billing/invoices/:id', async (ctx) => {
  const invoice = await getInvoice(ctx.params.id);
  if (!invoice) {
    ctx.status = 404;
    ctx.body = { error: 'not_found' };
    return;
  }
  ctx.body = invoice;
});
`,
  ) },
  // r4: E2B sandbox, writes through /fs.
  { at: 22, who: 'r4', turn: 1, intent: 'Make the checkout tests pass on Node 22', file: 'src/checkout/cart.ts', to: edit(
    '  return JSON.parse(JSON.stringify(cart));', '  return structuredClone(cart);',
    '  cart.items.push({ sku: item.sku, qty: item.qty, price: product.price });', '  const existing = cart.items.find((i) => i.sku === item.sku);\n  if (existing) existing.qty += item.qty;\n  else cart.items.push({ sku: item.sku, qty: item.qty, price: product.price });',
    '  carts.set(id, cart);\n  return cart;', '  carts.set(id, cart);\n  return structuredClone(cart);',
  ) },
  { at: 18, who: 'r1', turn: 2, intent: 'Now write the tests for it', file: 'test/billing.test.ts', to: src`
import { describe, it, expect, beforeEach } from 'vitest';
import { addToCart, resetCarts } from '../src/checkout/cart';
import { createInvoice, getInvoice } from '../src/billing/invoice';

describe('billing', () => {
  beforeEach(() => resetCarts());

  it('creates an open invoice for the cart total', async () => {
    await addToCart('c1', { sku: 'tee-black-m', qty: 2 });
    const invoice = await createInvoice('c1');
    expect(invoice.status).toBe('open');
    expect(invoice.total).toEqual({ amount: 5800, currency: 'USD' });
  });

  it('refuses to invoice an empty cart', async () => {
    await expect(createInvoice('empty')).rejects.toThrow('empty cart');
  });

  it('finds an invoice by id', async () => {
    await addToCart('c2', { sku: 'mug-white', qty: 1 });
    const { id } = await createInvoice('c2');
    expect(await getInvoice(id)).toMatchObject({ id, cartId: 'c2' });
  });
});
` },
  // r2: Codex renames the logger. Its server.ts edit touches r5's line.
  { at: 14, who: 'r2', turn: 1, intent: 'Rename the app logger to log', file: 'src/log.ts', to: edit('export const logger = {', 'export const log = {') },
  { at: 13, who: 'r2', turn: 1, file: 'src/server.ts', to: edit(
    "import { logger } from './log';", "import { log } from './log';",
    'logger.info(`${ctx.method}', 'log.info(`${ctx.method}',
    'logger.info(`shop-api listening', 'log.info(`shop-api listening',
  ) },
  // r3: the header, in its own worktree.
  { at: 9, who: 'r3', turn: 1, intent: 'Fix the header on mobile: add a menu button and collapse the nav under 640px', wt: HDR, file: 'web/Header.tsx', to: edit(
    '      <nav className="header__nav">', src`
      <button
        className="header__menu"
        aria-expanded={open}
        aria-controls="site-nav"
        onClick={() => setOpen((o) => !o)}
      >
        Menu
      </button>
      <nav id="site-nav" className="header__nav" data-open={open}>`,
  ) },
  { at: 8, who: 'r3', turn: 1, wt: HDR, file: 'web/header.css', to: (s) => s + src`

.header__menu {
  display: none;
}

@media (max-width: 640px) {
  .header {
    padding: 12px 16px;
    gap: 12px;
  }
  .header__menu {
    display: inline-flex;
    margin-left: auto;
  }
  .header__nav {
    display: none;
    position: absolute;
    inset: 56px 0 auto;
    flex-direction: column;
    padding: 16px;
    background: var(--surface);
  }
  .header__nav[data-open='true'] {
    display: flex;
  }
}
` },
  { at: 7, who: 'r4', turn: 2, intent: 'Also cover merging the same sku and the empty cart', file: 'test/cart.test.ts', to: edit(
    "    expect((await getCart('b')).items).toHaveLength(1);\n  });\n", src`
    expect((await getCart('b')).items).toHaveLength(1);
  });

  it('merges the same sku into one line', async () => {
    await addToCart('c', { sku: 'mug-white', qty: 1 });
    const cart = await addToCart('c', { sku: 'mug-white', qty: 2 });
    expect(cart.items).toEqual([expect.objectContaining({ sku: 'mug-white', qty: 3 })]);
  });

  it('starts empty', async () => {
    expect(await getCart('nobody')).toMatchObject({ items: [], total: { amount: 0 } });
  });
`,
  ) },
  { at: 5, who: 'r2', turn: 2, intent: 'Keep a deprecated logger alias until every caller is moved', file: 'src/log.ts', to: (s) => s + src`

/** @deprecated Use \`log\`. Kept until every caller is migrated. */
export const logger = log;
` },
  { at: 4, who: 'r1', turn: 3, intent: 'Handle refunds too, partial and full', file: 'src/billing/invoice.ts', to: edit(
    "  status: 'open' | 'paid' | 'void';\n  createdAt: string;\n", "  status: 'open' | 'paid' | 'refunded' | 'void';\n  refunded?: Money;\n  createdAt: string;\n",
    'export async function getInvoice(id: string): Promise<Invoice | undefined> {\n  return invoices.get(id);\n}\n', src`
export async function getInvoice(id: string): Promise<Invoice | undefined> {
  return invoices.get(id);
}

export async function refundInvoice(id: string, amount?: number): Promise<Invoice> {
  const invoice = invoices.get(id);
  if (!invoice) throw new Error(\`No invoice $\{id}\`);
  if (invoice.status !== 'paid') throw new Error(\`Invoice $\{id} is $\{invoice.status}, not paid\`);
  const refund = amount ?? invoice.total.amount;
  if (refund <= 0 || refund > invoice.total.amount) throw new Error('Refund must be between 0 and the invoice total');
  invoice.refunded = { amount: refund, currency: invoice.total.currency };
  invoice.status = refund === invoice.total.amount ? 'refunded' : 'paid';
  return invoice;
}
`,
  ) },
  { at: 3, who: 'r1', turn: 3, file: 'src/routes.ts', to: edit(
    "import { createInvoice, getInvoice } from './billing/invoice';", "import { createInvoice, getInvoice, refundInvoice } from './billing/invoice';",
    '  ctx.body = invoice;\n});\n', '  ctx.body = invoice;\n});\n',
  ) },
  { at: 2, who: 'r1', turn: 3, file: 'test/billing.test.ts', to: edit(
    "import { createInvoice, getInvoice } from '../src/billing/invoice';", "import { createInvoice, getInvoice, refundInvoice } from '../src/billing/invoice';",
    "    expect(await getInvoice(id)).toMatchObject({ id, cartId: 'c2' });\n  });\n", src`
    expect(await getInvoice(id)).toMatchObject({ id, cartId: 'c2' });
  });

  it('refunds part of a paid invoice', async () => {
    await addToCart('c3', { sku: 'tee-black-m', qty: 1 });
    const invoice = await createInvoice('c3');
    invoice.status = 'paid';
    const refunded = await refundInvoice(invoice.id, 1000);
    expect(refunded.refunded).toEqual({ amount: 1000, currency: 'USD' });
    expect(refunded.status).toBe('paid');
  });
`,
  ) },
];

// The refund route goes in at the end of routes.ts (second edit above is a no-op anchor).
STEPS.find((s) => s.at === 3).to = ((prev) => (s) => prev(s) + src`

routes.post('/billing/invoices/:id/refund', async (ctx) => {
  const { amount } = ctx.body as { amount?: number };
  ctx.body = await refundInvoice(ctx.params.id, amount);
});
`)(STEPS.find((s) => s.at === 3).to);

// ---------------------------------------------------------------- line diff (LCS)

const lines = (s) => (s === null || s === undefined || s === '' ? [] : s.replace(/\n$/, '').split('\n'));

// For each line of b, the index of the matching line in a, or -1.
function match(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const from = new Array(m).fill(-1);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { from[j] = i; i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return from;
}

// Edit script: [{t:' '|'-'|'+', s, o, n}] with 1-based old/new line numbers.
function script(a, b) {
  const from = match(a, b);
  // Removed lines come before added ones, like git.
  const out = [];
  let i = 0;
  let adds = [];
  for (let j = 0; j < b.length; j++) {
    if (from[j] >= 0) {
      while (i < from[j]) { out.push({ t: '-', s: a[i], o: i + 1 }); i++; }
      out.push(...adds);
      adds = [];
      out.push({ t: ' ', s: b[j], o: i + 1, n: j + 1 });
      i++;
    } else adds.push({ t: '+', s: b[j], n: j + 1 });
  }
  while (i < a.length) { out.push({ t: '-', s: a[i], o: i + 1 }); i++; }
  out.push(...adds);
  return out;
}

function hunks(beforeText, afterText, ctx = 3) {
  const a = lines(beforeText), b = lines(afterText);
  const ops = script(a, b);
  const changed = ops.map((o, k) => (o.t !== ' ' ? k : -1)).filter((k) => k >= 0);
  if (!changed.length) return [];
  const groups = [];
  for (const k of changed) {
    const lo = Math.max(0, k - ctx), hi = Math.min(ops.length - 1, k + ctx);
    const g = groups.at(-1);
    if (g && lo <= g.hi + 1) g.hi = Math.max(g.hi, hi);
    else groups.push({ lo, hi });
  }
  return groups.map(({ lo, hi }) => {
    const part = ops.slice(lo, hi + 1);
    let oldStart = 0, newStart = 0;
    // Line numbers where the hunk starts, as git prints them.
    for (let k = lo; k >= 0 && (!oldStart || !newStart); k--) {
      if (!oldStart && ops[k].o) oldStart = ops[k].o + (k === lo ? 0 : 1);
      if (!newStart && ops[k].n) newStart = ops[k].n + (k === lo ? 0 : 1);
    }
    const oldLines = part.filter((o) => o.t !== '+').length;
    const newLines = part.filter((o) => o.t !== '-').length;
    return {
      oldStart: oldLines ? (part.find((o) => o.o)?.o ?? oldStart) : Math.max(0, oldStart - 1),
      oldLines,
      newStart: newLines ? (part.find((o) => o.n)?.n ?? newStart) : Math.max(0, newStart - 1),
      newLines,
      lines: part.map((o) => ({ t: o.t, s: o.s })),
    };
  });
}

const counts = (a, b) => {
  const ops = script(lines(a), lines(b));
  return { added: ops.filter((o) => o.t === '+').length, removed: ops.filter((o) => o.t === '-').length };
};

// ---------------------------------------------------------------- replay the story

const who = (k) => (k === 'out' ? OUTSIDE : { ...RUNS[k], key: k });
const state = { [MAIN]: { ...HEAD }, [HDR]: { ...HEAD_HDR } };
const changes = []; // recorded changes (outside edits are not recorded)
const versions = new Map();
const keep = (text) => {
  const s = sha1(text);
  if (s) versions.set(s, text);
  return s;
};
for (const [wt, files] of Object.entries(state)) for (const t of Object.values(files)) keep(t);

const steps = [...STEPS].sort((a, b) => b.at - a.at);
let id = 0;
for (const st of steps) {
  const wt = st.wt ?? MAIN;
  const before = state[wt][st.file] ?? null;
  const after = typeof st.to === 'function' ? st.to(before) : st.to;
  state[wt][st.file] = after;
  if (after === null) delete state[wt][st.file];
  if (st.who === 'out') continue;
  const w = who(st.who);
  changes.push({
    id: ++id, ts: min(st.at), run: w.run, label: w.label, turn: st.turn, wt, path: st.file,
    ...counts(before, after), before, after, before_sha: keep(before), after_sha: keep(after), who: st.who, intent: st.intent,
  });
}

const headOf = (wt, p) => (wt === MAIN ? HEAD : HEAD_HDR)[p] ?? null;
const nowOf = (wt, p) => state[wt][p] ?? null;
const changesOf = (wt, p) => changes.filter((c) => c.wt === wt && c.path === p);

// Replays a file like src/attribution.js: who[i] authors lines[i].
function replay(wt, p) {
  const cs = changesOf(wt, p);
  let cur = cs.length ? cs[0].before_sha : sha1(nowOf(wt, p));
  let ls = lines(cs.length ? cs[0].before : nowOf(wt, p));
  let w = ls.map(() => null);
  const ends = new Map();
  const step = (next, author) => {
    const from = match(ls, next);
    w = next.map((_, j) => (from[j] >= 0 ? w[from[j]] : author));
    ls = next;
  };
  for (const c of cs) {
    if (c.before_sha !== cur) step(lines(c.before), OUT_AUTHOR);
    step(lines(c.after), { run: c.run, label: c.label, turn: c.turn });
    cur = c.after_sha;
    ends.set(c.run, w.filter((a) => a?.run === c.run).length);
  }
  if (sha1(nowOf(wt, p)) !== cur) step(lines(nowOf(wt, p)), OUT_AUTHOR);
  return { lines: ls, who: w, ends };
}

function blameOf(wt, p) {
  const r = replay(wt, p);
  const head = lines(headOf(wt, p));
  const from = match(head, r.lines);
  const out = [];
  r.lines.forEach((text, i) => {
    if (from[i] < 0) out.push({ line: i + 1, text, ...(r.who[i] ?? { run: null, label: 'outside agents', turn: null }) });
  });
  return {
    path: p, base: 'HEAD', changes: changesOf(wt, p).length, exists: nowOf(wt, p) !== null, untracked: false,
    lines: out, removed: head.length - from.filter((i) => i >= 0).length,
  };
}

function fileStatus(wt, p, run) {
  const r = replay(wt, p);
  const end = r.ends.get(run);
  const kept = r.who.filter((a) => a?.run === run).length;
  const mine = changesOf(wt, p).filter((c) => c.run === run);
  if (end > 0) return kept === end ? 'yes' : kept === 0 ? 'no' : 'partly';
  const now = sha1(nowOf(wt, p));
  if (now === mine.at(-1).after_sha) return 'yes';
  if (now === mine[0].before_sha) return 'no';
  return '?';
}

// ---------------------------------------------------------------- reviews, branches, undo plans

const REVIEW = {
  r6: { status: 'approved', note: 'Checked the zod 4 migration guide; issues[] is the new name.', at: min(101), by: 'human:alex' },
  r7: { status: 'rejected', note: 'Not adding Redis for this. Undone.', at: min(119), by: 'human:alex' },
};
const BRANCH = { r6: 'grapim/cursor-3e9a' };
const PENDING = { status: 'pending', note: null, at: null, by: null };

const runKeys = Object.keys(RUNS);
const runRows = {};
const details = {};
for (const k of runKeys) {
  const R = RUNS[k];
  const mine = changes.filter((c) => c.who === k);
  const files = [...new Set(mine.map((c) => c.path))];
  const turns = [...new Set(mine.map((c) => c.turn))].sort((a, b) => a - b).map((t) => {
    const cs = mine.filter((c) => c.turn === t);
    return { turn: t, intent: cs.find((c) => c.intent)?.intent ?? null, ts: Math.min(...cs.map((c) => c.ts)) - 20_000, files: [...new Set(cs.map((c) => c.path))] };
  });
  const fileRows = files.map((p) => {
    const cs = mine.filter((c) => c.path === p);
    const before = cs[0].before, after = cs.at(-1).after;
    const st = fileStatus(R.worktree, p, R.run);
    return {
      path: p, ...counts(before, after), untracked: false,
      state: st === 'no' ? 'gone' : st === 'partly' ? 'partial' : 'in_tree',
      diff: { hunks: hunks(before, after) },
      _status: st,
    };
  });
  const known = fileRows.map((f) => f._status).filter((s) => s !== '?');
  const in_tree = known.every((s) => s === 'yes') ? 'all' : known.every((s) => s === 'no') ? 'none' : 'some';
  const row = {
    run: R.run, label: R.label, worktree: R.worktree, intent: turns.at(-1).intent || turns[0].intent,
    turns: turns.length, files: files.length,
    added: fileRows.reduce((n, f) => n + f.added, 0), removed: fileRows.reduce((n, f) => n + f.removed, 0),
    in_tree, first_ts: turns[0].ts, last_ts: Math.max(...mine.map((c) => c.ts)), active: R.active,
    review: REVIEW[k] ?? PENDING, branch: BRANCH[k] ?? null,
  };
  // Intent of the run is its first prompt; later turns are follow-ups.
  row.intent = turns[0].intent ?? null;
  runRows[k] = row;
  details[k] = { run: row, turns, files: fileRows.map(({ _status, ...f }) => f) };
}

// Who holds what right now (active agents only).
const LEASES = {
  r1: ['src/routes.ts', 'src/billing/invoice.ts', 'test/billing.test.ts'],
  r2: ['src/log.ts', 'src/server.ts'],
  r3: ['web/Header.tsx', 'web/header.css'],
  r4: ['src/checkout/cart.ts', 'test/cart.test.ts'],
};
const holderOf = (wt, p) => {
  for (const [k, ps] of Object.entries(LEASES)) if (RUNS[k].worktree === wt && ps.includes(p)) return RUNS[k];
  return null;
};

const ROOTS = { [MAIN]: 'C:/Users/alex/code/shop-api', [HDR]: 'C:/Users/alex/code/shop-api-header' };
const WHY_HELD = (h) => `held by ${h.label} right now, so --yes will skip it`;

function planOf(k) {
  const R = RUNS[k];
  return {
    applied: false, run: R.run, label: R.label, turn: null,
    files: details[k].files.map((f) => {
      const base = { path: f.path, root: ROOTS[R.worktree] };
      if (f.state === 'gone') return { ...base, action: 'nothing', reason: null };
      const mine = changes.filter((c) => c.who === k && c.path === f.path);
      const later = changes.filter((c) => c.wt === R.worktree && c.path === f.path && c.who !== k && c.ts > mine[0].ts);
      const action = mine[0].before === null && !later.length ? 'delete' : mine.at(-1).after === null ? 'restore' : 'revert';
      const h = holderOf(R.worktree, f.path);
      return { ...base, action, reason: h && h.run !== R.run ? WHY_HELD(h) : null };
    }),
  };
}
const plans = Object.fromEntries(runKeys.map((k) => [k, planOf(k)]));
// r5's server.ts line was later rewritten by Codex, and git merge-file sees adjacent edits as a conflict.
for (const f of plans.r5.files) {
  if (f.path === 'src/server.ts') Object.assign(f, { action: 'conflict', reason: "later edits overlap this run's lines (1 conflicting hunk)" });
}

// ---------------------------------------------------------------- events

const events = [];
const ev = (ts, k, kind, p = null, detail = null) => {
  const R = k === 'u7' || k === 'human' ? { run: 'human:alex', label: 'human:alex' } : RUNS[k];
  events.push({ ts, agent: R.run, label: R.label, kind, path: p, detail });
};
const claimed = new Set();
for (const c of changes) {
  if (c.who === 'u7') { ev(c.ts, 'u7', 'undo', c.path, `${c.after === null ? 'delete' : 'revert'}: claude 0c4d5e6f`); continue; }
  if (c.intent) ev(c.ts - 20_000, c.who, 'intent', null, c.intent);
  const key = `${c.who}|${c.path}`;
  if (!claimed.has(key)) { claimed.add(key); ev(c.ts - 4_000, c.who, 'claim', c.path, RUNS[c.who] && details[c.who].turns.find((t) => t.turn === c.turn)?.intent); }
  ev(c.ts, c.who, 'edit', c.path, `+${c.added} -${c.removed}`);
}
// Blocks: Codex tried to touch files others hold.
ev(min(12.5), 'r2', 'blocked', 'src/checkout/cart.ts', 'held by e2b-5d0c');
ev(min(3.5), 'r2', 'blocked', 'src/routes.ts', 'held by claude 1a2b3c4d');
ev(min(16), 'r4', 'blocked', 'src/routes.ts', 'held by claude 1a2b3c4d');
// Ended runs release their files and end.
for (const [k, at] of [['r7', 170], ['r6', 126], ['r5', 41]]) {
  for (const p of details[k].files.map((f) => f.path)) ev(min(at), k, 'release', p);
  ev(min(at) + 1000, k, 'end');
}
// Review and branch events are logged under the run they are about.
ev(min(119), 'r7', 'review', null, 'rejected');
ev(min(101), 'r6', 'review', null, 'approved');
ev(min(100), 'r6', 'branch', null, 'grapim/cursor-3e9a 4f1c2e9a7b3d');
events.sort((a, b) => a.ts - b.ts);
events.forEach((e, i) => (e.id = 1000 + i));

// ---------------------------------------------------------------- overview and file listings

const lastSeen = { r1: min(0.2), r2: min(0.6), r3: min(1.4), r4: min(0.9) };
const agents = ['r1', 'r2', 'r3', 'r4'].map((k) => ({
  agent: RUNS[k].run, label: RUNS[k].label, worktree: RUNS[k].worktree,
  intent: details[k].turns.at(-1).intent, last_seen: lastSeen[k], files: LEASES[k],
}));
const leases = Object.entries(LEASES).flatMap(([k, ps]) => ps.map((p) => {
  const first = changes.find((c) => c.who === k && c.path === p);
  const last = changes.filter((c) => c.who === k && c.path === p).at(-1);
  return {
    path: p, agent: RUNS[k].run, label: RUNS[k].label, worktree: RUNS[k].worktree,
    intent: details[k].turns.at(-1).intent, acquired_at: first.ts - 4_000, expires_at: last.ts + 30 * 60_000,
  };
}));
const runList = runKeys.map((k) => runRows[k]).sort((a, b) => b.last_ts - a.last_ts);
const overview = {
  repo: 'shop-api', root: ROOTS[MAIN],
  worktrees: [
    { name: MAIN, root: ROOTS[MAIN], branch: 'main' },
    { name: HDR, root: ROOTS[HDR], branch: 'agent/header-mobile' },
  ],
  agents, leases,
  counts: { agents: agents.length, leases: leases.length, runs: runList.length, unreviewed: runList.filter((r) => r.review.status === 'pending').length },
};

function listing(dir) {
  const prefix = dir ? `${dir}/` : '';
  const entries = new Map();
  for (const p of Object.keys(state[MAIN]).sort()) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const name = rest.split('/')[0];
    const isDir = rest.includes('/');
    if (entries.has(name)) continue;
    const full = prefix + name;
    if (isDir) entries.set(name, { name, path: full, type: 'dir', size: 0, last_change: null, held_by: null });
    else {
      const last = changes.filter((c) => c.wt === MAIN && c.path === full).at(-1);
      entries.set(name, {
        name, path: full, type: 'file', size: Buffer.byteLength(state[MAIN][full]),
        last_change: last ? { ts: last.ts, label: last.label, run: last.run } : null,
        held_by: holderOf(MAIN, full)?.label ?? null,
      });
    }
  }
  // A folder's last change is its newest file change.
  for (const e of entries.values()) {
    if (e.type !== 'dir') continue;
    const last = changes.filter((c) => c.wt === MAIN && c.path.startsWith(`${e.path}/`) && state[MAIN][c.path] !== undefined).at(-1);
    e.last_change = last ? { ts: last.ts, label: last.label, run: last.run } : null;
  }
  return [...entries.values()].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
}
const dirs = new Set(['']);
for (const p of Object.keys(state[MAIN])) {
  const parts = p.split('/');
  for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
}

// ---------------------------------------------------------------- write

for (const f of ['index.json']) rmSync(path.join(OUT, f), { force: true });
rmSync(path.join(OUT, 'data'), { recursive: true, force: true });
mkdirSync(path.join(OUT, 'data', 'versions'), { recursive: true });
const routes = {};
const slug = (s) => s.replace(/[^a-zA-Z0-9.]+/g, '_').replace(/^_|_$/g, '') || 'root';
const put = (route, file, body) => {
  routes[route] = file;
  writeFileSync(path.join(OUT, file), typeof body === 'string' ? body : JSON.stringify(body, null, 2) + '\n');
};

put('GET /api/overview', 'data/overview.json', overview);
put('GET /api/runs', 'data/runs.json', runList);
put('GET /api/events', 'data/events.json', events);
for (const k of runKeys) {
  const short = RUNS[k].label.replace(/ /g, '-');
  put(`GET /api/runs/${RUNS[k].run}`, `data/run.${short}.json`, details[k]);
  put(`POST /api/runs/${RUNS[k].run}/undo`, `data/undo.${short}.json`, plans[k]);
}
for (const d of dirs) put(`GET /api/files?path=${d ? `${d}/` : ''}`, `data/files.${slug(d)}.json`, listing(d));
for (const p of Object.keys(state[MAIN]).concat(['src/cache.ts'])) {
  const cs = changesOf(MAIN, p);
  if (cs.length) {
    put(`GET /api/files/history?path=${p}`, `data/history.${slug(p)}.json`, cs.map((c) => ({
      id: c.id, ts: c.ts, run: c.run, label: c.label, turn: c.turn, added: c.added, removed: c.removed, before_sha: c.before_sha, after_sha: c.after_sha,
    })));
    put(`GET /api/blame?path=${p}`, `data/blame.${slug(p)}.json`, blameOf(MAIN, p));
  } else {
    put(`GET /api/files/history?path=${p}`, 'data/history.empty.json', []);
    put(`GET /api/blame?path=${p}`, `data/blame.${slug(p)}.json`, { path: p, base: 'HEAD', changes: 0, exists: nowOf(MAIN, p) !== null, untracked: false, lines: [], removed: 0 });
  }
  if (nowOf(MAIN, p) !== null) routes[`GET /fs/${p}`] = `data/versions/${sha1(nowOf(MAIN, p))}.txt`;
}
for (const [s, text] of versions) {
  writeFileSync(path.join(OUT, 'data', 'versions', `${s}.txt`), text);
  routes[`GET /api/files/version?sha=${s}`] = `data/versions/${s}.txt`;
}
writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({
  note: 'Mock-mode fixtures for the review desk. Each file under data/ is an exact response body from docs/api.md. Generated by _generate.mjs; times are shifted so generated_at becomes "now".',
  generated_at: GEN,
  routes,
}, null, 2) + '\n');

console.log(`${Object.keys(routes).length} routes, ${changes.length} changes, ${events.length} events, ${versions.size} versions`);
for (const r of runList) console.log(`${r.label.padEnd(16)} ${String(r.turns).padStart(2)} turns ${String(r.files).padStart(2)} files +${r.added} -${r.removed} in_tree=${r.in_tree} ${r.review.status}`);
console.log('undo r5:', plans.r5.files.map((f) => `${f.action} ${f.path}`).join(', '));
