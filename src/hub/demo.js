// The public, read-only demo (docs/deploy.md, GRAPIM_DEMO=1): GET /demo signs
// a visitor in for two hours as a synthetic viewer of one sample team, so the
// hub can be looked around without GitHub or an install.
//
// - The demo team (DEMO_TEAM_ID) is sample data from src/hub/demo-seed.js,
//   seeded when the hub starts and again once a day, so its runs stay recent.
// - Every person in it, and the viewer, has a negative user id. GitHub ids are
//   positive and sign in refuses anything else (auth.js profile()), so no real
//   account can ever be one of them; with the demo off, auth.js does not load
//   a session for a negative id at all.
// - A demo session is read-only: server.js refuses every request that is not
//   GET or HEAD before it reaches a route, the workspace mount or the platform
//   API, except signing out. The viewer belongs to the demo team only, so any
//   other team answers 404 as it does for anyone who is not a member.
// - Ask Grapim is shown with a note instead of the model (no model calls).

import { tx } from './db.js';
import { HttpError, redirect } from './http.js';
import { DAY, HOUR, MACHINES, seedRunHistory, seedTeamExtras } from './demo-seed.js';

export const DEMO_TEAM_ID = 'demo-acme';
export const DEMO_SESSION_MS = 2 * HOUR;
export const DEMO_READ_ONLY = 'This is a read-only demo. Sign in with GitHub to use Grapim on your own repos.';

// The viewer every /demo session signs in as (a member, not an owner).
export const DEMO_VIEWER = Object.freeze({ id: -1, login: 'demo-visitor', name: 'Demo visitor' });
// The sample team's people. Logins are display names only: nobody signs in as them.
export const DEMO_USERS = Object.freeze([
  Object.freeze({ id: -1001, login: 'dana', name: 'Dana Whitfield' }),
  Object.freeze({ id: -1002, login: 'sam', name: 'Sam Ortiz' }),
  Object.freeze({ id: -1003, login: 'priya', name: 'Priya Rao' }),
]);
// A GitHub installation, account and repository ids never use negative numbers either.
const DEMO_INSTALLATION = Object.freeze({ id: -77001, accountId: -9001, login: 'acme-co', repoIds: [-5001, -5002] });

export const isDemoUserId = (id) => Number.isSafeInteger(id) && id < 0;

// Rows of the demo team kept when it is seeded again: the team itself, its
// members (the viewer's sessions stay valid) and the workspace with its files.
const KEEP = new Set(['teams', 'members', 'workspaces', 'workspace_tokens', 'workspace_connectors', 'team_usage', 'team_storage', 'billing_events']);

// Requests a demo session may make that are not GET or HEAD.
const WRITES_ALLOWED = new Set(['POST /hub/logout']);
// GET routes that change something (they link GitHub installations).
const GETS_REFUSED = [/^\/hub\/github\/setup\/?$/];

export function createDemo(hub, { enabled = false, reseedMs = DAY } = {}) {
  const { db, log } = hub;
  let seededAt = 0;
  let seeding = null;
  let timer = null;

  function clear() {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name)
      .filter((t) => !KEEP.has(t) && db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = 'team_id'`).get(t));
    for (const t of tables) db.prepare(`DELETE FROM "${t}" WHERE team_id = ?`).run(DEMO_TEAM_ID);
  }

  // Writes (or rewrites) the demo team, relative to now.
  async function seed() {
    const now = hub.now();
    const [owner] = DEMO_USERS;
    tx(db, () => {
      clear();
      seedRunHistory(db, { team: { id: DEMO_TEAM_ID, name: 'Acme', plan: 'governance', seats: 8 }, owner, machines: MACHINES, now });
      db.prepare(
        `INSERT INTO users (id, login, name, avatar_url, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)
         ON CONFLICT(id) DO UPDATE SET login = excluded.login, name = excluded.name, updated_at = excluded.updated_at`,
      ).run(DEMO_VIEWER.id, DEMO_VIEWER.login, DEMO_VIEWER.name, now, now);
      db.prepare("INSERT OR IGNORE INTO members (team_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)").run(DEMO_TEAM_ID, DEMO_VIEWER.id, now);
    });
    const [dana, sam, priya] = DEMO_USERS;
    await seedTeamExtras(hub, {
      teamId: DEMO_TEAM_ID,
      users: DEMO_USERS,
      machines: { 'dana-mbp': dana.id, 'sam-linux': sam.id, 'priya-mbp': priya.id, 'ci-runner': sam.id },
      installation: DEMO_INSTALLATION,
      now,
    });
    seededAt = now;
  }

  function refresh() {
    if (seeding) return seeding;
    seeding = seed()
      .catch((err) => log(`demo: seeding the demo team failed: ${err?.message ?? err}`))
      .finally(() => {
        seeding = null;
      });
    return seeding;
  }

  async function start() {
    if (!enabled) return;
    await refresh();
    // Seeded again once a day, so the newest runs stay minutes old.
    timer = setInterval(() => {
      if (hub.now() - seededAt >= reseedMs) refresh();
    }, Math.min(reseedMs, HOUR));
    timer.unref();
  }

  // Throws for anything a demo session may not do. Called by server.js for
  // every request that carries one, before any route or the workspace mount.
  function guard(ctx, pathname) {
    const m = ctx.req.method;
    if (m === 'GET' || m === 'HEAD') {
      if (GETS_REFUSED.some((re) => re.test(pathname))) throw new HttpError(403, 'demo_read_only', DEMO_READ_ONLY);
      return;
    }
    if (WRITES_ALLOWED.has(`${m} ${pathname.replace(/\/$/, '')}`)) return;
    ctx.req.resume();
    throw new HttpError(403, 'demo_read_only', DEMO_READ_ONLY);
  }

  function routes(router) {
    if (!enabled) return;
    router.get(
      '/demo',
      async (ctx) => {
        if (seeding) await seeding;
        if (!hub.teams.membership(DEMO_TEAM_ID, DEMO_VIEWER.id)) throw new HttpError(503, 'demo_unavailable', 'The demo is being set up. Try again in a minute.');
        const to = `/hub/teams/${DEMO_TEAM_ID}`;
        if (ctx.session?.demo) return redirect(ctx.res, to);
        // Signed in for real: that session ends here, the demo replaces it in this browser.
        if (ctx.session) hub.auth.destroy(ctx.session);
        const s = hub.auth.createSession(DEMO_VIEWER.id, { ttlMs: DEMO_SESSION_MS });
        redirect(ctx.res, to, { 'Set-Cookie': s.cookie });
      },
      { rate: 'demo' },
    );
  }

  return {
    enabled,
    teamId: DEMO_TEAM_ID,
    start,
    seed: refresh,
    guard,
    routes,
    get seededAt() {
      return seededAt;
    },
    // Stops the daily timer; resolves once a seeding in flight is done.
    close() {
      clearInterval(timer);
      return seeding ?? Promise.resolve();
    },
  };
}
