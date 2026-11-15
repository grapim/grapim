// Slack notifications per team (research/core-features-2026-11.md, feature 3).
//
// An owner pastes a Slack incoming webhook URL in Settings. The hub posts:
// - a digest of agent runs waiting for approval, at most once per DIGEST_MS
//   (15 minutes), listing each run once;
// - a message when the Grapim check fails on a pull request, once per head commit.
//
// The URL is a secret (it alone lets anyone post to the channel):
// - only https://hooks.slack.com/services/<T>/<B>/<secret> is accepted, so the
//   hub never sends a request anywhere else (no SSRF: a fixed host, port 443,
//   no credentials in the URL, redirects never followed);
// - it is sealed with AES-256-GCM (src/hub/platform/util.js sealer) under a
//   key of its own derived from HUB_SECRET and bound to the team, never
//   logged, never sent back to a page (only its last four characters);
// - Slack answering 403, 404 or 410 (revoked, channel gone or archived) turns
//   the webhook off until an owner saves it again.

import { HttpError, redirect } from './http.js';
import { sealer } from './platform/util.js';
import { kindOf } from '../provenance/note.js';

export const DIGEST_MS = 15 * 60 * 1000;
export const TICK_MS = 60 * 1000;
const SENT_DAYS = 30;
const MAX_LIST = 10;
const PEOPLE = new Set(['sync', 'undo', 'restore']);

export const NOTIFY_SCHEMA = `
CREATE TABLE IF NOT EXISTS team_notify (
  team_id     TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
  slack_url   TEXT NOT NULL,                  -- sealed (AES-256-GCM, bound to the team)
  hint        TEXT NOT NULL,                  -- the URL's last 4 characters
  set_by      INTEGER,
  set_at      INTEGER NOT NULL,
  cursor      INTEGER NOT NULL DEFAULT 0,     -- newest h_changes.id already considered for a digest
  last_sent_at INTEGER,
  last_ok_at  INTEGER,
  last_error  TEXT,
  disabled_at INTEGER
);
CREATE TABLE IF NOT EXISTS notify_sent (
  team_id TEXT NOT NULL,
  key     TEXT NOT NULL,
  at      INTEGER NOT NULL,
  PRIMARY KEY (team_id, key)
);
`;

// The one URL shape accepted, or null.
export function slackUrl(input) {
  const s = String(input ?? '').trim();
  if (s.length > 300) return null;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.hostname !== 'hooks.slack.com' || u.port || u.username || u.password || u.search || u.hash) return null;
  if (!/^\/services\/[A-Z0-9]{6,20}\/[A-Z0-9]{6,20}\/[A-Za-z0-9]{16,64}$/.test(u.pathname)) return null;
  return `https://hooks.slack.com${u.pathname}`;
}

// Slack mrkdwn: escape &, < and > in text that is not ours.
export const esc = (s) => String(s ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const link = (url, text) => `<${url}|${esc(text).replace(/\|/g, '¦')}>`;
const clip = (s, n) => {
  const t = String(s ?? '').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export function createNotifier(hub, options = {}) {
  const { db, now, log, config } = hub;
  db.exec(NOTIFY_SCHEMA);
  const seal = sealer(config.secret, 'grapim notify seal v1');
  const aad = (teamId) => `team_notify\nslack\n${teamId}`;
  const send = options.fetch ?? globalThis.fetch;
  const origin = String(config.origin ?? '').replace(/\/+$/, '');
  const row = (teamId) => db.prepare('SELECT * FROM team_notify WHERE team_id = ?').get(teamId) ?? null;

  function save(teamId, url, userId) {
    const ok = slackUrl(url);
    if (!ok) throw new HttpError(400, 'bad_request', 'Paste a Slack incoming webhook URL: https://hooks.slack.com/services/T…/B…/…');
    const t = now();
    const cursor = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM h_changes WHERE team_id = ?').get(teamId).id;
    db.prepare(
      `INSERT INTO team_notify (team_id, slack_url, hint, set_by, set_at, cursor) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(team_id) DO UPDATE SET slack_url = excluded.slack_url, hint = excluded.hint, set_by = excluded.set_by,
         set_at = excluded.set_at, cursor = excluded.cursor, last_error = NULL, disabled_at = NULL`,
    ).run(teamId, seal.seal(ok, aad(teamId)), ok.slice(-4), userId, t, cursor);
  }

  const remove = (teamId) => db.prepare('DELETE FROM team_notify WHERE team_id = ?').run(teamId).changes > 0;

  // Posts one message. -> true when Slack took it.
  async function post(teamId, text) {
    const r = row(teamId);
    if (!r || r.disabled_at) return false;
    const url = slackUrl(seal.open(r.slack_url, aad(teamId)));
    if (!url) {
      db.prepare('UPDATE team_notify SET last_error = ?, disabled_at = ? WHERE team_id = ?').run('The saved webhook could not be read. Save it again.', now(), teamId);
      return false;
    }
    let res;
    try {
      res = await send(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'grapim-hub' },
        body: JSON.stringify({ text, unfurl_links: false, unfurl_media: false }),
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      db.prepare('UPDATE team_notify SET last_error = ? WHERE team_id = ?').run('Slack did not answer.', teamId);
      return false;
    }
    const body = String(await res.text().catch(() => '')).replace(/[^a-z_]/g, '').slice(0, 60);
    if (res.status === 200) {
      db.prepare('UPDATE team_notify SET last_ok_at = ?, last_error = NULL WHERE team_id = ?').run(now(), teamId);
      return true;
    }
    // No URL, team or channel in the log line.
    log(`slack webhook answered ${res.status}`);
    const gone = res.status === 403 || res.status === 404 || res.status === 410;
    db.prepare('UPDATE team_notify SET last_error = ?, disabled_at = ? WHERE team_id = ?').run(
      `Slack answered ${res.status}${body ? ` (${body})` : ''}.${gone ? ' Notifications are off until you save a working webhook.' : ''}`,
      gone ? now() : null,
      teamId,
    );
    return false;
  }

  // Runs synced since the cursor that no member has approved yet.
  function waiting(teamId, cursor) {
    const rows = db
      .prepare(
        `SELECT c.repo_id, c.run, MAX(c.id) AS id, MAX(c.label) AS label, c.machine, COALESCE(r.github, r.name) AS repo_name
         FROM h_changes c JOIN repos r ON r.team_id = c.team_id AND r.id = c.repo_id
         WHERE c.team_id = ? AND c.id > ? GROUP BY c.repo_id, c.run ORDER BY MAX(c.id) LIMIT 500`,
      )
      .all(teamId, cursor);
    const top = rows.reduce((m, r) => Math.max(m, r.id), cursor);
    const latest = hub.github?.reviews;
    const list = rows.filter((r) => !PEOPLE.has(kindOf(r.run)) && !r.run.startsWith('human:')).filter((r) => {
      const h = latest ? latest.latest(teamId, [r.repo_id], [r.run]).get(r.run) : null;
      return !(h && h.status === 'approved' && !h.stale);
    });
    const intent = db.prepare('SELECT intent FROM h_agents WHERE team_id = ? AND repo_id = ? AND agent = ? AND intent IS NOT NULL ORDER BY last_seen DESC LIMIT 1');
    return { top, list: list.map((r) => ({ ...r, intent: intent.get(teamId, r.repo_id, r.run)?.intent ?? null })) };
  }

  // One digest per team, at most every DIGEST_MS. -> how many teams got one.
  async function tick() {
    let sent = 0;
    const teams = db.prepare('SELECT team_id, cursor, last_sent_at FROM team_notify WHERE disabled_at IS NULL').all();
    for (const t of teams) {
      if (t.last_sent_at && now() - t.last_sent_at < DIGEST_MS) continue;
      const { top, list } = waiting(t.team_id, t.cursor);
      if (!list.length) {
        if (top > t.cursor) db.prepare('UPDATE team_notify SET cursor = ? WHERE team_id = ?').run(top, t.team_id);
        continue;
      }
      const team = hub.teams.get(t.team_id);
      const lines = list.slice(0, MAX_LIST).map((r) => {
        const href = `${origin}/hub/teams/${encodeURIComponent(t.team_id)}/repos/${r.repo_id}/runs/${encodeURIComponent(r.run)}?machine=${encodeURIComponent(r.machine)}`;
        return `• ${link(href, clip(r.label || r.run, 40))} in ${esc(clip(r.repo_name, 60))}${r.intent ? `: ${esc(clip(r.intent, 100))}` : ''}`;
      });
      const more = list.length > MAX_LIST ? `\n…and ${list.length - MAX_LIST} more. ${link(`${origin}/hub/teams/${encodeURIComponent(t.team_id)}/reviews`, 'Open Reviews')}` : '';
      const text = `*${list.length} agent run${list.length === 1 ? '' : 's'} waiting for approval* in ${esc(team?.name ?? 'your team')}\n${lines.join('\n')}${more}`;
      const ok = await post(t.team_id, text);
      // Sent or not, the next digest waits: a failing webhook is not retried every minute.
      db.prepare('UPDATE team_notify SET last_sent_at = ?, cursor = ? WHERE team_id = ?').run(now(), ok ? top : t.cursor, t.team_id);
      if (ok) sent++;
    }
    db.prepare('DELETE FROM notify_sent WHERE at < ?').run(now() - SENT_DAYS * 24 * 60 * 60 * 1000);
    return sent;
  }

  // The Grapim check failed on a pull request: once per head commit.
  async function checkFailed({ teamId, owner, name, number, headSha, title }) {
    if (!row(teamId) || row(teamId).disabled_at) return false;
    const key = `check:${owner}/${name}#${number}@${headSha}`.slice(0, 300);
    const fresh = db.prepare('INSERT OR IGNORE INTO notify_sent (team_id, key, at) VALUES (?, ?, ?)').run(teamId, key, now()).changes > 0;
    if (!fresh) return false;
    const url = `https://github.com/${owner}/${name}/pull/${number}`;
    return post(teamId, `*Grapim check failed* on ${link(url, `${owner}/${name}#${number}`)}: ${esc(clip(title, 200))}`);
  }

  // ---- Settings ----

  const FORM = { auth: 'session', csrf: true, team: true, owner: true };
  const back = (ctx, done) => redirect(ctx.res, `/hub/teams/${ctx.member.team.id}/settings/notifications?done=${done}`);
  function routes(router) {
    router.post(
      '/hub/teams/:team/notifications/slack',
      async (ctx) => {
        try {
          save(ctx.member.team.id, ctx.form.url, ctx.session.user.id);
        } catch (err) {
          if (err instanceof HttpError && err.status === 400 && hub.renderSettings) return hub.renderSettings(ctx, { error: err.message }, 400);
          throw err;
        }
        back(ctx, 'slack_saved');
      },
      FORM,
    );
    router.post(
      '/hub/teams/:team/notifications/slack/test',
      async (ctx) => {
        if (!row(ctx.member.team.id)) throw new HttpError(404, 'not_found', 'No Slack webhook is saved.');
        hub.limit(ctx, 'form', `slack-test:${ctx.member.team.id}`);
        const team = hub.teams.get(ctx.member.team.id);
        const ok = await post(ctx.member.team.id, `Grapim is connected. This channel will hear about agent runs waiting for approval in ${esc(team?.name ?? 'your team')} and failed Grapim checks.`);
        back(ctx, ok ? 'slack_tested' : 'slack_failed');
      },
      FORM,
    );
    router.post(
      '/hub/teams/:team/notifications/slack/remove',
      (ctx) => {
        remove(ctx.member.team.id);
        back(ctx, 'slack_removed');
      },
      FORM,
    );
  }

  // What the settings card shows: never the URL.
  function info(teamId) {
    const r = row(teamId);
    return r ? { hint: r.hint, set_at: r.set_at, last_ok_at: r.last_ok_at, last_error: r.last_error, disabled: !!r.disabled_at } : null;
  }

  let timer = null;
  if (options.schedule !== false) {
    timer = setInterval(() => tick().catch((err) => log(`slack digest failed: ${err?.message ?? err}`)), options.tickMs ?? TICK_MS);
    timer.unref();
  }

  return { routes, info, save, remove, post, tick, checkFailed, close: () => clearInterval(timer) };
}
