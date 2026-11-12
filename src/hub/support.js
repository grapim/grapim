// Help and feedback (/hub/support): a signed-in person writes to the people
// who run this hub; the hub's admins (HUB_ADMINS, GitHub logins or numeric
// ids) read the messages at /hub/admin/support. Messages are plain text,
// escaped when shown, at most 10 per person a day.

import { HttpError, redirect, sendHtml } from './http.js';
import { csrfField, layout } from './pages/layout.js';
import { html, time } from './pages/html.js';

const TOPICS = Object.freeze({ help: 'I need help', bug: 'Something is broken', idea: 'An idea or request', pilot: 'A Team or Governance pilot', other: 'Something else' });
const PER_DAY = 10;
const MAX_TEXT = 4000;

export function ensureSupportSchema(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS support_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  login      TEXT NOT NULL,
  topic      TEXT NOT NULL,
  body       TEXT NOT NULL,
  page       TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS support_messages_user ON support_messages (user_id, created_at);
`);
}

const isAdmin = (config, user) => !!config.admins && (config.admins.includes(String(user.id)) || config.admins.includes(String(user.login).toLowerCase()));

function formPage({ user, csrf, sent = false, error = null, topic = 'help', body = '', page = '' }) {
  return layout({
    title: 'Help and feedback',
    user,
    csrf,
    toast: sent ? 'Sent. We read every message and usually reply within a day.' : null,
    body: html`<header class="page-head">
  <div class="page-head-main"><h1>Help and feedback</h1><p class="page-sub">Stuck, found a bug, or want something changed? Write to the people who build Grapim. The <a class="link" href="/docs">docs</a> may answer it faster.</p></div>
</header>
${error ? html`<p class="notice notice-error" role="alert">${error}</p>` : ''}
<form method="post" action="/hub/support" class="card support-form">
  ${csrfField(csrf)}
  <input type="hidden" name="page" value="${page}">
  <fieldset class="support-topics">
    <legend class="label">What is it about?</legend>
    ${Object.entries(TOPICS).map(([k, v]) => html`<label class="radio"><input type="radio" name="topic" value="${k}" ${k === topic ? 'checked' : ''}> ${v}</label>`)}
  </fieldset>
  <label class="label" for="support-body">Message</label>
  <textarea id="support-body" class="input" name="body" rows="8" maxlength="${MAX_TEXT}" required placeholder="What happened, what you expected, and the page or command if there is one.">${body}</textarea>
  <p class="muted small">Sent as @${user.login}. We reply to the public email on your GitHub profile; if it has none, say in the message how to reach you. Don't paste tokens or secrets.</p>
  <div><button class="btn btn-primary" type="submit">Send</button></div>
</form>`,
  });
}

const PILOT_PLANS = Object.freeze({ free: 'Free', team: 'Team', governance: 'Governance' });

function adminPage({ user, csrf, rows, teams = [], toast = null }) {
  return layout({
    title: 'Support messages',
    user,
    csrf,
    toast,
    body: html`<header class="page-head"><div class="page-head-main"><h1>Admin</h1><p class="page-sub">Design partner teams and Help and feedback messages.</p></div></header>
<section class="card" aria-labelledby="pilot-title">
  <div class="card-head"><h2 id="pilot-title" class="card-title">Pilot plans</h2></div>
  <p class="muted small">Puts a team on a plan without billing, for a design partner pilot (Governance turns on Require review and reports). Shown to the team as "pilot".</p>
  ${teams.length
    ? html`<ul class="list">${teams.map((t) => html`<li class="row">
    <div class="row-main"><p><strong>${t.name}</strong> <span class="muted small mono">${t.id}</span> · ${t.members} ${t.members === 1 ? 'member' : 'members'} · <span class="badge">${t.plan}${t.plan_status ? ` · ${t.plan_status}` : ''}</span></p></div>
    <form method="post" action="/hub/admin/teams/plan" class="inline-form">
      ${csrfField(csrf)}
      <input type="hidden" name="team" value="${t.id}">
      <label class="sr-only" for="plan-${t.id}">Plan for ${t.name}</label>
      <select id="plan-${t.id}" name="plan">${Object.entries(PILOT_PLANS).map(([k, v]) => html`<option value="${k}" ${k === t.plan ? 'selected' : ''}>${v}</option>`)}</select>
      <button class="btn btn-sm" type="submit">Set</button>
    </form>
  </li>`)}</ul>`
    : html`<p class="muted">No teams yet.</p>`}
</section>
<h2 class="section-title">Help and feedback <span class="muted num">${rows.length}</span></h2>
${rows.length
  ? html`<ul class="list">${rows.map((r) => html`<li class="row support-row">
    <div class="row-main">
      <p><strong>${TOPICS[r.topic] ?? r.topic}</strong> · <a class="link" href="https://github.com/${r.login}" rel="noopener noreferrer">@${r.login}</a> · ${time(r.created_at)}${r.page ? html` · <span class="muted small">${r.page}</span>` : ''}</p>
      <p class="support-body">${r.body}</p>
    </div>
  </li>`)}</ul>`
  : html`<p class="muted">No messages yet.</p>`}`,
  });
}

export function supportRoutes(router, hub) {
  const { db, config } = hub;
  ensureSupportSchema(db);
  const SESSION = { auth: 'session' };
  const FORM = { auth: 'session', csrf: true };
  const cleanPage = (v) => {
    const s = String(v ?? '').slice(0, 300);
    return /^\/(hub|w|docs)(\/[^\s<>"']*)?$/.test(s) ? s : '';
  };

  router.get('/hub/support', (ctx) => {
    const q = ctx.url.searchParams;
    sendHtml(ctx.res, 200, formPage({ user: ctx.session.user, csrf: ctx.session.csrf, sent: q.get('sent') === '1', topic: TOPICS[q.get('topic')] ? q.get('topic') : 'help', page: cleanPage(q.get('from')) }));
  }, SESSION);

  router.post('/hub/support', (ctx) => {
    const u = ctx.session.user;
    const topic = TOPICS[ctx.form.topic] ? ctx.form.topic : 'other';
    const body = String(ctx.form.body ?? '').replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim();
    const page = cleanPage(ctx.form.page);
    const again = (error, status) => sendHtml(ctx.res, status, formPage({ user: u, csrf: ctx.session.csrf, error, topic, body: body.slice(0, MAX_TEXT), page }));
    if (!body) return again('Write a message first.', 400);
    if (body.length > MAX_TEXT) return again(`A message can be at most ${MAX_TEXT} characters.`, 400);
    const today = db.prepare('SELECT COUNT(*) AS n FROM support_messages WHERE user_id = ? AND created_at > ?').get(u.id, hub.now() - 86_400_000).n;
    if (today >= PER_DAY) return again(`You have sent ${PER_DAY} messages today. Try again tomorrow.`, 429);
    db.prepare('INSERT INTO support_messages (user_id, login, topic, body, page, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(u.id, u.login, topic, body, page || null, hub.now());
    hub.log(`support: a message from user ${u.id} (${topic})`);
    redirect(ctx.res, '/hub/support?sent=1');
  }, FORM);

  router.get('/hub/admin/support', (ctx) => {
    if (!isAdmin(config, ctx.session.user)) throw new HttpError(404, 'not_found', 'Not found.');
    const rows = db.prepare('SELECT * FROM support_messages ORDER BY created_at DESC LIMIT 200').all();
    const teams = db.prepare("SELECT t.id, t.name, t.plan, t.plan_status, (SELECT COUNT(*) FROM members m WHERE m.team_id = t.id) AS members FROM teams t WHERE t.kind IS NOT 'platform' ORDER BY t.created_at DESC LIMIT 200").all();
    const toast = ctx.url.searchParams.get('done') === 'plan' ? 'Plan updated.' : null;
    sendHtml(ctx.res, 200, adminPage({ user: ctx.session.user, csrf: ctx.session.csrf, rows, teams, toast }));
  }, SESSION);

  // A pilot plan for a design partner, without billing. Never touches a team
  // that pays through Stripe (it has a subscription).
  router.post('/hub/admin/teams/plan', (ctx) => {
    if (!isAdmin(config, ctx.session.user)) throw new HttpError(404, 'not_found', 'Not found.');
    const plan = Object.hasOwn(PILOT_PLANS, ctx.form.plan) ? ctx.form.plan : null;
    const team = hub.teams.get(String(ctx.form.team ?? ''));
    if (!plan || !team) throw new HttpError(400, 'bad_request', 'Pick a team and a plan.');
    if (team.subscription_id) throw new HttpError(409, 'conflict', 'This team pays through billing; change its plan there.');
    hub.teams.setPlan(team.id, { plan, status: plan === 'free' ? 'active' : 'pilot' });
    hub.log(`admin: team ${team.id} set to ${plan} by user ${ctx.session.user.id}`);
    redirect(ctx.res, '/hub/admin/support?done=plan');
  }, FORM);
}
