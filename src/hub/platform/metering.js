// Metering (docs/platform.md, "Metering and pricing"): writes and API calls
// per workspace per UTC day, a daily storage sample, the usage API, the
// month-to-date estimate with the price table from billing.js, the test-mode
// caps, and the daily Stripe Billing Meter report.
//
// Counts are added in memory and written every 2 s (and before any read), so
// a busy workspace costs one upsert per flush, not one per request. A crash
// loses at most those 2 s of api_calls; writes are re-derived from the
// workspace ledger cursor, which only moves in the same flush.

import { PLATFORM_PRICES } from '../billing.js';
import { tx } from '../db.js';
import { apiError, DAY_MS, dayOf, invalid } from './util.js';

const FLUSH_MS = 2000;
const MAX_RANGE_DAYS = 93;
export const MAX_USAGE_ROWS = 100_000; // per GET /v1/usage, before paging or grouping
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

export function createMetering({ hub, prices = PLATFORM_PRICES, reportMeterEvent = null, env = {}, log }) {
  const { db, now } = hub;
  const pending = new Map(); // `${workspace_id}|${day}` -> { team_id, mode, writes, api_calls }
  let cursorsDue = new Map(); // workspace id -> { change_id, event_id } to save with the next flush

  const modeOf = (ws) => (ws.mode === 'test' ? 'test' : 'live');

  function bump(ws, { writes = 0, apiCalls = 0 } = {}) {
    const day = dayOf(now());
    const k = `${ws.id}|${day}`;
    const p = pending.get(k) ?? { team_id: ws.team_id, workspace_id: ws.id, day, mode: modeOf(ws), writes: 0, api_calls: 0 };
    p.writes += writes;
    p.api_calls += apiCalls;
    pending.set(k, p);
  }

  function flush() {
    if (!pending.size && !cursorsDue.size) return;
    const rows = [...pending.values()];
    const cursors = cursorsDue;
    pending.clear();
    cursorsDue = new Map();
    tx(db, () => {
      const up = db.prepare(
        `INSERT INTO usage_daily (team_id, workspace_id, day, mode, writes, api_calls) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, day) DO UPDATE SET writes = writes + excluded.writes, api_calls = api_calls + excluded.api_calls`,
      );
      for (const r of rows) up.run(r.team_id, r.workspace_id, r.day, r.mode, r.writes, r.api_calls);
      const cur = db.prepare('INSERT INTO platform_cursors (workspace_id, change_id, event_id) VALUES (?, ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET change_id = excluded.change_id, event_id = excluded.event_id');
      for (const [id, c] of cursors) cur.run(id, c.change_id, c.event_id);
    });
  }

  // The events module saves its ledger cursor with the counts it produced.
  const saveCursor = (wsId, c) => cursorsDue.set(wsId, c);
  const cursorOf = (wsId) => cursorsDue.get(wsId) ?? db.prepare('SELECT change_id, event_id FROM platform_cursors WHERE workspace_id = ?').get(wsId) ?? null;

  // ---- test-mode caps ----

  function testWorkspacesLeft(teamId) {
    const n = db.prepare("SELECT COUNT(*) AS n FROM workspaces WHERE team_id = ? AND mode = 'test' AND deleted_at IS NULL").get(teamId).n;
    return prices.testCaps.workspaces - n;
  }

  function testWritesToday(teamId) {
    flush();
    return db.prepare("SELECT COALESCE(SUM(writes), 0) AS n FROM usage_daily WHERE team_id = ? AND mode = 'test' AND day = ?").get(teamId, dayOf(now())).n;
  }

  // Throws when a test workspace's platform used today's test writes.
  function checkTestWrite(ws) {
    if (ws.mode !== 'test') return;
    if (testWritesToday(ws.team_id) >= prices.testCaps.writesPerDay) {
      throw apiError(429, 'test_mode_limit', `Test mode allows ${prices.testCaps.writesPerDay} writes a day per platform. Use a live key, or wait until 00:00 UTC.`);
    }
  }

  // ---- storage ----

  // The day's storage sample for every live platform workspace (once a day).
  function sampleStorage(day = dayOf(now())) {
    flush();
    const rows = db
      .prepare(
        `SELECT w.id, w.team_id, w.mode, w.bytes FROM workspaces w JOIN teams t ON t.id = w.team_id
         WHERE t.kind = 'platform' AND w.deleted_at IS NULL`,
      )
      .all();
    tx(db, () => {
      const up = db.prepare(
        `INSERT INTO usage_daily (team_id, workspace_id, day, mode, storage_bytes) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, day) DO UPDATE SET storage_bytes = COALESCE(storage_bytes, excluded.storage_bytes)`,
      );
      for (const w of rows) up.run(w.team_id, w.id, day, modeOf(w), w.bytes);
    });
    return rows.length;
  }

  // ---- reading ----

  function range(q) {
    const today = dayOf(now());
    const from = q.get('from') || `${today.slice(0, 8)}01`;
    const to = q.get('to') || today;
    const re = /^\d{4}-\d{2}-\d{2}$/;
    if (!re.test(from) || !re.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) throw invalid('from and to are days: YYYY-MM-DD (UTC).');
    if (from > to) throw invalid('from is after to.');
    if ((Date.parse(to) - Date.parse(from)) / DAY_MS >= MAX_RANGE_DAYS) throw invalid(`Ask for at most ${MAX_RANGE_DAYS} days at a time.`);
    return { from, to };
  }

  // GET /v1/usage rows. group_by: none (per workspace per day), workspace or day.
  function usage(teamId, mode, q) {
    flush();
    const { from, to } = range(q);
    const groupBy = q.get('group_by') ?? '';
    if (!['', 'workspace', 'day'].includes(groupBy)) throw invalid('group_by is workspace or day.');
    const rows = db
      .prepare(
        `SELECT u.workspace_id, w.external_id, u.day, u.writes, u.api_calls, COALESCE(u.storage_bytes, 0) AS storage_byte_days
         FROM usage_daily u LEFT JOIN workspaces w ON w.id = u.workspace_id
         WHERE u.team_id = ? AND u.mode = ? AND u.day BETWEEN ? AND ? ORDER BY u.day, u.workspace_id LIMIT ?`,
      )
      .all(teamId, mode, from, to, MAX_USAGE_ROWS + 1);
    // Every live workspace has a row every day (the storage sample): 10,000
    // workspaces over 93 days would be 930,000 objects in memory for one
    // call. Past the cap, ask for a shorter range (review H2).
    if (rows.length > MAX_USAGE_ROWS) throw invalid(`This range has over ${MAX_USAGE_ROWS.toLocaleString('en-US')} usage rows. Ask for fewer days at a time.`);
    if (!groupBy) return { from, to, rows: rows.map((r) => ({ ...r, active: r.writes > 0 })) };
    const groups = new Map();
    for (const r of rows) {
      const k = groupBy === 'workspace' ? r.workspace_id : r.day;
      const g =
        groups.get(k) ??
        (groupBy === 'workspace'
          ? { workspace_id: r.workspace_id, external_id: r.external_id, day: null, writes: 0, api_calls: 0, storage_byte_days: 0, active: false }
          : { workspace_id: null, external_id: null, day: r.day, writes: 0, api_calls: 0, storage_byte_days: 0, active: 0 });
      g.writes += r.writes;
      g.api_calls += r.api_calls;
      g.storage_byte_days += r.storage_byte_days;
      if (r.writes > 0) g.active = groupBy === 'workspace' ? true : g.active + 1;
      groups.set(k, g);
    }
    return { from, to, rows: [...groups.values()] };
  }

  // Month-to-date totals and the estimated bill (live only bills).
  function estimate(teamId, mode = 'live', month = dayOf(now()).slice(0, 7)) {
    flush();
    const t = db
      .prepare(
        `SELECT COALESCE(SUM(writes), 0) AS writes, COALESCE(SUM(api_calls), 0) AS api_calls,
                COALESCE(SUM(storage_bytes), 0) AS byte_days,
                COUNT(DISTINCT CASE WHEN writes > 0 THEN workspace_id END) AS active
         FROM usage_daily WHERE team_id = ? AND mode = ? AND substr(day, 1, 7) = ?`,
      )
      .get(teamId, mode, month);
    const [y, m] = month.split('-').map(Number);
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const gbMonths = t.byte_days / daysInMonth / GIB;
    const lines = [
      { item: 'Active workspaces', quantity: t.active, unit: 'workspace-month', unit_price: prices.activeWorkspaceMonth, amount: t.active * prices.activeWorkspaceMonth },
      { item: 'Writes', quantity: t.writes, unit: '1,000 writes', unit_price: prices.per1000Writes, amount: (t.writes / 1000) * prices.per1000Writes },
      { item: 'Storage', quantity: gbMonths, unit: 'GB-month', unit_price: prices.perGbMonth, amount: gbMonths * prices.perGbMonth },
    ];
    const subtotal = lines.reduce((s, l) => s + l.amount, 0);
    const billed = mode === 'live';
    return {
      month,
      mode,
      currency: prices.currency,
      writes: t.writes,
      api_calls: t.api_calls,
      active_workspaces: t.active,
      storage_gb_months: gbMonths,
      lines,
      subtotal,
      minimum: billed ? prices.monthlyMinimum : 0,
      total: billed ? Math.max(subtotal, prices.monthlyMinimum) : 0,
    };
  }

  // ---- Stripe Billing Meters ----

  const meterNames = () => {
    const out = {};
    for (const [k, envName] of Object.entries(prices.meters)) out[k] = String(env[envName] ?? '').trim();
    return out;
  };
  const meteringOn = () => !!reportMeterEvent && !!String(env.STRIPE_SECRET_KEY ?? '').trim() && Object.values(meterNames()).every(Boolean);

  // The three meter values of one platform for one finished day (live only).
  function dayValues(teamId, day) {
    const r = db
      .prepare("SELECT COALESCE(SUM(writes), 0) AS writes, COALESCE(SUM(storage_bytes), 0) AS bytes FROM usage_daily WHERE team_id = ? AND mode = 'live' AND day = ?")
      .get(teamId, day);
    // Workspaces whose first write of the month was this day: summed over a
    // month, that is the active workspace-months.
    const firsts = db
      .prepare(
        `SELECT COUNT(*) AS n FROM (SELECT workspace_id, MIN(day) AS first FROM usage_daily
           WHERE team_id = ? AND mode = 'live' AND writes > 0 AND substr(day, 1, 7) = ? GROUP BY workspace_id) WHERE first = ?`,
      )
      .get(teamId, day.slice(0, 7), day).n;
    return { writes: r.writes, activeWorkspaces: firsts, storage: Math.round(r.bytes / MIB) };
  }

  // Reports every finished day of the last 3 that is not reported yet, for
  // every live platform with a Stripe customer. Idempotent per (platform,
  // day, meter): recorded here, and the identifier is Stripe's dedupe key.
  async function reportMeters() {
    if (!meteringOn()) return { reported: 0, skipped: 'not configured' };
    flush();
    const names = meterNames();
    const today = dayOf(now());
    const days = [1, 2, 3].map((i) => dayOf(Date.parse(today) - i * DAY_MS));
    let reported = 0;
    for (const team of db.prepare("SELECT id, customer_id FROM teams WHERE kind = 'platform'").all()) {
      if (!team.customer_id) continue;
      for (const day of days) {
        const values = dayValues(team.id, day);
        for (const [meter, value] of Object.entries(values)) {
          if (db.prepare('SELECT 1 FROM meter_reports WHERE team_id = ? AND day = ? AND meter = ?').get(team.id, day, meter)) continue;
          const identifier = `grapim-${team.id}-${day}-${meter}`;
          try {
            if (value > 0) {
              await reportMeterEvent({ eventName: names[meter], customerId: team.customer_id, value, identifier, timestamp: Math.floor(Date.parse(day) / 1000) + 43_200 });
            }
            db.prepare('INSERT OR IGNORE INTO meter_reports (team_id, day, meter, value, identifier, reported_at) VALUES (?, ?, ?, ?, ?, ?)').run(team.id, day, meter, value, identifier, now());
            reported++;
          } catch (err) {
            log(`stripe meter report ${meter} failed: ${err?.code ?? err?.name ?? 'error'}`);
          }
        }
      }
    }
    return { reported };
  }

  const timer = setInterval(() => {
    try {
      flush();
    } catch (err) {
      log(`metering flush: ${err?.message ?? err}`);
    }
  }, FLUSH_MS);
  timer.unref();

  return {
    bump,
    flush,
    saveCursor,
    cursorOf,
    testWorkspacesLeft,
    testWritesToday,
    checkTestWrite,
    sampleStorage,
    usage,
    estimate,
    reportMeters,
    meteringOn,
    prices,
    close() {
      clearInterval(timer);
      try {
        flush();
      } catch {}
    },
  };
}
