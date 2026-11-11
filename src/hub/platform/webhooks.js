// Webhooks (docs/platform.md, "Webhooks"): endpoints, a durable outbox in
// SQLite, and a delivery worker.
//
// - emit() writes the event and one delivery row per endpoint that wants it,
//   in one transaction, so nothing is lost if the process stops.
// - The worker sends due deliveries: Grapim-Signature: t=<unix>,v1=<hex
//   HMAC-SHA256 of "<t>.<body>" with the endpoint secret>. A 2xx is
//   delivered; anything else is retried with backoff (8 attempts over about
//   24 h). An endpoint whose deliveries keep failing for 3 days is disabled.
// - Fair delivery (review M9): at most PER_PLATFORM deliveries of one
//   platform are in flight, MAX_IN_FLIGHT in all, and a free slot goes to the
//   next platform in turn (round robin), not to the oldest delivery. Nothing
//   waits for a batch: each delivery that ends starts the next. A delivery
//   with no answer in 10 s fails, and its endpoint is paused (1 min, doubling
//   up to 1 h while it keeps timing out), so a hanging endpoint holds at most
//   its own platform's slots, and only for one delivery each.
// - Every attempt re-checks the URL (https, public addresses only after DNS)
//   and connects to the address it checked (ssrf.js).

import crypto from 'node:crypto';
import { tx } from '../db.js';
import { randomToken } from '../secure.js';
import { pinnedPost, UrlRefused, vet } from './ssrf.js';
import { apiError, DAY_MS, invalid, unix } from './util.js';

export const EVENT_TYPES = ['workspace.created', 'workspace.deleted', 'run.started', 'run.updated', 'run.reviewed', 'run.undone', 'edit.blocked', 'file.restored'];
// Delay after attempt n fails (n = 1..7); attempt 8 is the last. Sums to about 23.6 h.
export const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 60 * 60_000, 3 * 60 * 60_000, 6 * 60 * 60_000, 13 * 60 * 60_000];
export const MAX_ATTEMPTS = BACKOFF_MS.length + 1;
export const GIVE_UP_MS = DAY_MS;
export const DISABLE_AFTER_MS = 3 * DAY_MS;
const MAX_ENDPOINTS = 16; // per platform and mode
export const PER_PLATFORM = 2; // deliveries in flight per platform
export const MAX_IN_FLIGHT = 16; // deliveries in flight in all
export const DELIVERY_TIMEOUT_MS = 10_000;
export const PAUSE_MS = 60_000; // an endpoint's first pause after a timeout; doubled each time, up to MAX_PAUSE_MS
export const MAX_PAUSE_MS = 60 * 60_000;

class DeliveryTimeout extends Error {
  constructor(ms) {
    super(`no answer within ${ms / 1000} s`);
    this.name = 'TimeoutError';
  }
}
const isTimeout = (err) => err instanceof DeliveryTimeout || err?.name === 'TimeoutError' || err?.name === 'AbortError' || /timed out/i.test(String(err?.message ?? ''));

export function sign(secret, body, t) {
  return `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

// The sealed signing secret is bound to its endpoint and platform (review M1).
const secretAad = (endpointId, teamId) => `webhook_endpoint\n${teamId}\n${endpointId}`;

// options (tests): timeoutMs, perPlatform, maxInFlight.
export function createWebhooks({ hub, sealer, resolve, transport, log, timeoutMs = DELIVERY_TIMEOUT_MS, perPlatform = PER_PLATFORM, maxInFlight = MAX_IN_FLIGHT }) {
  const { db, now } = hub;
  const send = transport ?? pinnedPost;

  const endpointJson = (e, extra = {}) => ({
    id: e.id,
    object: 'webhook_endpoint',
    url: e.url,
    events: JSON.parse(e.events),
    livemode: e.mode === 'live',
    status: e.enabled ? 'enabled' : 'disabled',
    disabled_reason: e.disabled_reason ?? null,
    created_at: unix(e.created_at),
    ...extra,
  });

  function cleanEvents(raw) {
    if (!Array.isArray(raw) || !raw.length || raw.length > EVENT_TYPES.length) throw invalid(`events must be a non-empty array of: ${EVENT_TYPES.join(', ')}, or ["*"].`);
    if (raw.length === 1 && raw[0] === '*') return ['*'];
    const out = [...new Set(raw)];
    for (const e of out) if (!EVENT_TYPES.includes(e)) throw invalid(`Unknown event type ${String(e).slice(0, 40)}.`);
    return out;
  }

  async function create(teamId, mode, body) {
    const events = cleanEvents(body.events);
    let vetted;
    try {
      vetted = await vet(body.url, resolve);
    } catch (err) {
      if (err instanceof UrlRefused) throw apiError(400, err.code, err.message);
      throw err;
    }
    const n = db.prepare('SELECT COUNT(*) AS n FROM webhook_endpoints WHERE team_id = ? AND mode = ? AND deleted_at IS NULL').get(teamId, mode).n;
    if (n >= MAX_ENDPOINTS) throw apiError(409, 'conflict', `A platform can have ${MAX_ENDPOINTS} webhook endpoints per mode.`);
    const id = `we_${randomToken(12)}`;
    const secret = `whsec_${randomToken(32)}`;
    db.prepare('INSERT INTO webhook_endpoints (id, team_id, mode, url, events, secret_sealed, hint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      id,
      teamId,
      mode,
      vetted.url.toString(),
      JSON.stringify(events),
      sealer.seal(secret, secretAad(id, teamId)),
      secret.slice(-4),
      now(),
    );
    return endpointJson(get(teamId, mode, id), { secret });
  }

  function get(teamId, mode, id) {
    return db.prepare('SELECT * FROM webhook_endpoints WHERE id = ? AND team_id = ? AND mode = ? AND deleted_at IS NULL').get(String(id), teamId, mode) ?? null;
  }

  function list(teamId, mode) {
    return db.prepare('SELECT * FROM webhook_endpoints WHERE team_id = ? AND mode = ? AND deleted_at IS NULL ORDER BY created_at DESC, id DESC').all(teamId, mode);
  }

  function remove(teamId, mode, id) {
    const e = get(teamId, mode, id);
    if (!e) return null;
    tx(db, () => {
      db.prepare('UPDATE webhook_endpoints SET deleted_at = ?, enabled = 0 WHERE id = ?').run(now(), e.id);
      db.prepare("UPDATE webhook_deliveries SET status = 'failed', last_error = 'endpoint deleted', next_attempt_at = NULL WHERE endpoint_id = ? AND status = 'pending'").run(e.id);
    });
    return e;
  }

  // Queues an event for every enabled endpoint of the platform and mode that
  // wants it. Returns the event id.
  function emit(team, mode, type, workspace, data) {
    if (team?.kind !== 'platform') return null;
    const id = `evt_${randomToken(18)}`;
    const t = now();
    const payload = JSON.stringify({
      id,
      object: 'event',
      type,
      created: unix(t),
      livemode: mode === 'live',
      workspace: workspace ? { id: workspace.id, external_id: workspace.external_id ?? null } : null,
      data,
    });
    tx(db, () => {
      const targets = db
        .prepare('SELECT id, events FROM webhook_endpoints WHERE team_id = ? AND mode = ? AND enabled = 1 AND deleted_at IS NULL')
        .all(team.id, mode)
        .filter((e) => {
          const wants = JSON.parse(e.events);
          return wants.includes('*') || wants.includes(type);
        });
      // No endpoint wants it: nothing is kept, so a platform without webhooks
      // does not grow the outbox with every run (review M8).
      if (!targets.length) return;
      db.prepare('INSERT INTO webhook_events (id, team_id, mode, type, workspace_id, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, team.id, mode, type, workspace?.id ?? null, payload, t);
      for (const e of targets) {
        db.prepare("INSERT INTO webhook_deliveries (event_id, endpoint_id, team_id, status, next_attempt_at, created_at) VALUES (?, ?, ?, 'pending', ?, ?)").run(id, e.id, team.id, t, t);
      }
    });
    return id;
  }

  function fail(d, e, status, error) {
    const t = now();
    const attempts = d.attempts + 1;
    const giveUp = attempts >= MAX_ATTEMPTS || t - d.created_at >= GIVE_UP_MS;
    tx(db, () => {
      db.prepare('UPDATE webhook_deliveries SET status = ?, attempts = ?, last_attempt_at = ?, last_status = ?, last_error = ?, next_attempt_at = ? WHERE id = ?').run(
        giveUp ? 'failed' : 'pending',
        attempts,
        t,
        status,
        String(error).slice(0, 200),
        giveUp ? null : t + BACKOFF_MS[attempts - 1],
        d.id,
      );
      const since = e.failing_since ?? t;
      if (e.failing_since === null) db.prepare('UPDATE webhook_endpoints SET failing_since = ? WHERE id = ? AND failing_since IS NULL').run(t, e.id);
      if (t - since >= DISABLE_AFTER_MS) {
        db.prepare("UPDATE webhook_endpoints SET enabled = 0, disabled_at = ?, disabled_reason = 'Every delivery failed for 3 days.' WHERE id = ?").run(t, e.id);
        db.prepare("UPDATE webhook_deliveries SET status = 'failed', last_error = 'endpoint disabled', next_attempt_at = NULL WHERE endpoint_id = ? AND status = 'pending'").run(e.id);
        log(`webhook endpoint ${e.id} disabled after 3 days of failures`);
      }
    });
  }

  async function attempt(d) {
    const e = db.prepare('SELECT * FROM webhook_endpoints WHERE id = ?').get(d.endpoint_id);
    if (!e || !e.enabled || e.deleted_at) {
      db.prepare("UPDATE webhook_deliveries SET status = 'failed', last_error = 'endpoint disabled', next_attempt_at = NULL WHERE id = ?").run(d.id);
      return;
    }
    const ev = db.prepare('SELECT payload FROM webhook_events WHERE id = ?').get(d.event_id);
    const secret = sealer.open(e.secret_sealed, secretAad(e.id, e.team_id));
    if (!ev || !secret) {
      db.prepare("UPDATE webhook_deliveries SET status = 'failed', last_error = 'cannot sign (HUB_SECRET changed?)', next_attempt_at = NULL WHERE id = ?").run(d.id);
      return;
    }
    // Claimed: a slow attempt is not picked up again by the next tick.
    db.prepare('UPDATE webhook_deliveries SET next_attempt_at = ? WHERE id = ?').run(now() + 60_000, d.id);
    let status = null;
    let error = null;
    let timedOut = false;
    try {
      // DNS (5 s at most), connecting, sending and the answer: 10 s in all,
      // whatever the transport does.
      let timer;
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new DeliveryTimeout(timeoutMs)), timeoutMs);
        timer.unref?.();
      });
      const call = (async () => {
        const target = await vet(e.url, resolve);
        const t = Math.floor(now() / 1000);
        return send(target, {
          body: ev.payload,
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Grapim-Webhooks/1',
            'Grapim-Signature': sign(secret, ev.payload, t),
            'Grapim-Event-Id': d.event_id,
            'Grapim-Delivery-Id': String(d.id),
          },
        });
      })();
      call.catch(() => {}); // an answer after the deadline is dropped
      const r = await Promise.race([call, deadline]).finally(() => clearTimeout(timer));
      status = Number(r?.status) || null;
      if (status >= 200 && status < 300) {
        const at = now();
        tx(db, () => {
          db.prepare("UPDATE webhook_deliveries SET status = 'delivered', attempts = attempts + 1, last_attempt_at = ?, last_status = ?, last_error = NULL, delivered_at = ?, next_attempt_at = NULL WHERE id = ?").run(at, status, at, d.id);
          db.prepare('UPDATE webhook_endpoints SET failing_since = NULL, last_success_at = ?, backoff_until = NULL, backoff_ms = NULL WHERE id = ?').run(at, e.id);
        });
        return;
      }
      error = `HTTP ${status}`;
    } catch (err) {
      timedOut = isTimeout(err);
      error = err instanceof UrlRefused ? `refused: ${err.message}` : timedOut ? `timeout: ${err?.message ?? 'no answer'}` : `${err?.name ?? 'Error'}: ${err?.message ?? err}`;
    }
    const fresh = db.prepare('SELECT * FROM webhook_endpoints WHERE id = ?').get(e.id);
    // An endpoint that keeps timing out is paused as a whole: its other
    // deliveries wait instead of each holding a slot for 10 s. Any answer
    // (an error status too) ends the pause.
    // Deliveries that were in flight together time out together: one pause.
    // The pause doubles when the endpoint times out again after it ended.
    const t = now();
    if (!timedOut) {
      db.prepare('UPDATE webhook_endpoints SET backoff_until = NULL, backoff_ms = NULL WHERE id = ?').run(e.id);
    } else if (!(fresh.backoff_until > t)) {
      const pause = fresh.backoff_ms ? Math.min(MAX_PAUSE_MS, fresh.backoff_ms * 2) : PAUSE_MS;
      db.prepare('UPDATE webhook_endpoints SET backoff_until = ?, backoff_ms = ? WHERE id = ?').run(t + pause, pause, e.id);
    }
    fail(d, fresh, status, error);
  }

  // ---- the fair scheduler (review M9) ----

  const inFlight = new Map(); // team id -> deliveries in flight
  const flying = new Set(); // delivery ids in flight
  let lastTeam = ''; // the platform served last, for the round robin
  let started = 0; // deliveries started since the hub started
  let idle = []; // deliverDue() callers waiting for nothing to be in flight
  let pumping = false;

  // Due now, and its endpoint is not paused.
  const DUE = `FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id
    WHERE d.status = 'pending' AND d.next_attempt_at <= ? AND (e.backoff_until IS NULL OR e.backoff_until <= ?)`;
  // The platforms with a delivery due, in a stable order.
  const dueTeams = (t) => db.prepare(`SELECT DISTINCT d.team_id AS team ${DUE} ORDER BY d.team_id`).all(t, t).map((r) => r.team);
  // A platform's oldest due delivery that is not in flight.
  const nextOf = (team, t) =>
    db.prepare(`SELECT d.* ${DUE} AND d.team_id = ? AND d.id NOT IN (SELECT value FROM json_each(?)) ORDER BY d.next_attempt_at, d.id LIMIT 1`).get(t, t, team, JSON.stringify([...flying])) ?? null;

  function launch(d) {
    started++;
    flying.add(d.id);
    inFlight.set(d.team_id, (inFlight.get(d.team_id) ?? 0) + 1);
    attempt(d)
      .catch((err) => log(`webhook delivery: ${err?.name}: ${err?.message}`))
      .finally(() => {
        flying.delete(d.id);
        const n = (inFlight.get(d.team_id) ?? 1) - 1;
        if (n > 0) inFlight.set(d.team_id, n);
        else inFlight.delete(d.team_id);
        pump();
      });
  }

  // Starts due deliveries while there are free slots: one per platform per
  // turn, each platform at most perPlatform at once. Never waits for them.
  function pump() {
    if (pumping) return;
    pumping = true;
    try {
      for (;;) {
        if (flying.size >= maxInFlight) break;
        const t = now();
        const teams = dueTeams(t).filter((team) => (inFlight.get(team) ?? 0) < perPlatform);
        if (!teams.length) break;
        // This turn starts after the platform served last.
        const from = teams.findIndex((team) => team > lastTeam);
        const order = from <= 0 ? teams : [...teams.slice(from), ...teams.slice(0, from)];
        let any = false;
        for (const team of order) {
          if (flying.size >= maxInFlight) break;
          const d = nextOf(team, t);
          if (!d) continue;
          lastTeam = team;
          launch(d);
          any = true;
        }
        if (!any) break;
      }
    } catch (err) {
      log(`webhook worker: ${err?.message ?? err}`);
    } finally {
      pumping = false;
    }
    if (!flying.size && idle.length) {
      const waiting = idle;
      idle = [];
      for (const w of waiting) w();
    }
  }

  // Starts what is due and resolves once nothing is in flight any more, with
  // how many deliveries were started meanwhile ("deliver everything due now"
  // for tests and scripts). The worker only calls pump().
  function deliverDue() {
    const before = started;
    pump();
    if (!flying.size) return Promise.resolve(0);
    return new Promise((r) => idle.push(() => r(started - before)));
  }

  // The deliveries log for the hub page.
  function log100(teamId) {
    return db
      .prepare(
        `SELECT d.id, d.status, d.attempts, d.last_status, d.last_error, d.next_attempt_at, d.created_at, d.delivered_at,
                ev.type, ev.mode, ev.id AS event_id, e.url
         FROM webhook_deliveries d JOIN webhook_events ev ON ev.id = d.event_id JOIN webhook_endpoints e ON e.id = d.endpoint_id
         WHERE d.team_id = ? ORDER BY d.id DESC LIMIT 100`,
      )
      .all(teamId);
  }

  // Old events and deliveries go after 30 days.
  function sweep() {
    const cutoff = now() - 30 * DAY_MS;
    tx(db, () => {
      db.prepare("DELETE FROM webhook_deliveries WHERE created_at < ? AND status != 'pending'").run(cutoff);
      db.prepare('DELETE FROM webhook_events WHERE created_at < ? AND id NOT IN (SELECT event_id FROM webhook_deliveries)').run(cutoff);
    });
  }

  return {
    create,
    get,
    list,
    remove,
    emit,
    deliverDue,
    pump,
    inFlight: () => ({ total: flying.size, perPlatform: Object.fromEntries(inFlight) }),
    endpointJson,
    log: log100,
    allEndpoints: (teamId) => db.prepare('SELECT * FROM webhook_endpoints WHERE team_id = ? AND deleted_at IS NULL ORDER BY created_at DESC').all(teamId),
    sweep,
    transport: send,
  };
}
