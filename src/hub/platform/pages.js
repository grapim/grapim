// The platform's hub pages (owner only): turn a team into a platform, API
// keys, the origins that may embed the desk, webhook endpoints with their
// deliveries log, and month-to-date usage with the estimated bill.

import { csrfField, layout } from '../pages/layout.js';
import { date, html, time } from '../pages/html.js';
import { head, reveal } from '../pages/team.js';

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
const money = (n, currency = 'usd') => `${currency === 'usd' ? '$' : ''}${n.toFixed(2)}${currency === 'usd' ? '' : ` ${currency}`}`;
const num = (n) => Number(n).toLocaleString('en-US');

function notices({ notice, error }) {
  return html`${notice ? html`<p class="notice" role="status">${notice}</p>` : ''}
${error ? html`<p class="notice notice-error" role="alert">${error}</p>` : ''}`;
}

function subnav(team, current) {
  const link = (href, label, key) => html`<a class="btn btn-sm ${current === key ? 'btn-primary' : 'btn-ghost'}" href="${href}" ${current === key ? html`aria-current="page"` : ''}>${label}</a>`;
  return html`<nav class="inline-form" aria-label="Platform">
  ${link(`/hub/teams/${team.id}/platform`, 'Keys and embedding', 'keys')}
  ${link(`/hub/teams/${team.id}/platform/webhooks`, 'Webhooks', 'webhooks')}
  ${link(`/hub/teams/${team.id}/platform/usage`, 'Usage', 'usage')}
</nav>`;
}

function notPlatform({ team, csrf, mayEnable }) {
  return html`<section class="card" aria-labelledby="pf-title">
  <div class="card-head"><h2 id="pf-title" class="card-title">Make this team a platform</h2><span class="badge">beta</span></div>
  <p class="card-sub">For products that run AI agents for their own customers. A platform gets API keys to create a workspace per end customer, mint short-lived tokens for agent sandboxes, embed the review desk in its own app, and receive webhooks. It is billed by usage: active workspaces, writes and storage.</p>
  ${mayEnable
    ? html`<form method="post" action="/hub/teams/${team.id}/platform" class="inline-form" data-confirm="${`Turn ${team.name} into a platform? This cannot be undone in the beta.`}">
    ${csrfField(csrf)}
    <button class="btn btn-primary" type="submit">Turn into a platform</button>
  </form>`
    : html`<p class="fine">Platforms are in a closed beta on this hub. Ask the hub operator to add your account.</p>`}
</section>`;
}

const NO_SETTINGS = { embed_allowed_origins: [], workspace_storage_mb: 512 };

function originsForm(team, csrf, mode, settings) {
  return html`<form method="post" action="/hub/teams/${team.id}/platform/origins">
    ${csrfField(csrf)}
    <input type="hidden" name="mode" value="${mode}">
    <label for="${`origins-${mode}`}">${mode === 'live' ? 'Live' : 'Test'} origins</label>
    <textarea id="${`origins-${mode}`}" name="origins" rows="3" spellcheck="false" placeholder="https://app.example.com">${settings.embed_allowed_origins.join('\n')}</textarea>
    <p><button class="btn" type="submit">Save ${mode} origins</button> <span class="muted small">Each workspace may store ${settings.workspace_storage_mb} MB in ${mode} mode.</span></p>
  </form>`;
}

export function platformPage({ user, csrf, team, isPlatform, mayEnable, keys = [], settings = { live: NO_SETTINGS, test: NO_SETTINGS }, caps = { workspaces: 25, writesPerDay: 2000, storageMb: 100, workspaceDays: 7 }, disabled = [], origin, revealed = null, notice = null, error = null }) {
  return layout({
    title: `${team.name} platform`,
    user,
    csrf,
    team,
    crumbs: [{ label: 'Platform' }],
    body: html`${head(team, 'platform')}
${notices({ notice, error })}
${!isPlatform
  ? notPlatform({ team, csrf, mayEnable })
  : html`${subnav(team, 'keys')}
${disabled.length
  ? html`<p class="notice notice-error" role="alert">${disabled.length === 1 ? 'A webhook endpoint was' : `${disabled.length} webhook endpoints were`} disabled after failing for 3 days: ${disabled.map((e) => e.url).join(', ')}. <a href="/hub/teams/${team.id}/platform/webhooks">See deliveries</a>.</p>`
  : ''}
<section class="card" id="keys" aria-labelledby="keys-title">
  <div class="card-head"><h2 id="keys-title" class="card-title">API keys</h2></div>
  <p class="card-sub">A key acts for the whole platform: treat it like a database password. Test keys never bill, and are capped at ${num(caps.workspaces)} workspaces, ${num(caps.writesPerDay)} writes a day and ${num(caps.storageMb)} MB; each test workspace is deleted ${caps.workspaceDays} days after it was created. Keys stop working if you leave the team or stop being an owner.</p>
  ${revealed ? reveal({ id: 'reveal-key', title: `Key ${revealed.name} (${revealed.mode})`, value: revealed.value, hint: 'Copy it now. Only a hash is stored, so it cannot be shown again.' }) : ''}
  <form method="post" action="/hub/teams/${team.id}/platform/keys" class="inline-form">
    ${csrfField(csrf)}
    <label class="sr-only" for="key-name">Key name</label>
    <input id="key-name" name="name" type="text" maxlength="40" placeholder="Key name, e.g. backend-prod" required autocomplete="off" spellcheck="false">
    <label class="sr-only" for="key-mode">Mode</label>
    <select id="key-mode" name="mode"><option value="test">Test</option><option value="live">Live</option></select>
    <button class="btn" type="submit">Create key</button>
  </form>
  ${keys.length
    ? html`<ul class="list list-flush">
    ${keys.map(
      (k) => html`<li class="row">
      <span class="row-main"><span class="row-title">${k.name}</span><span class="badge">${k.mode}</span><span class="muted mono">…${k.hint}</span></span>
      <span class="row-meta">${k.owner || 'unknown'} · created ${date(k.created_at)} · used ${time(k.last_used_at)}</span>
      <form method="post" action="/hub/teams/${team.id}/platform/keys/${k.id}/revoke" data-confirm="${`Revoke the key ${k.name}? Calls with it fail at once.`}">${csrfField(csrf)}<button class="btn btn-ghost btn-sm btn-danger" type="submit" aria-label="${`Revoke key ${k.name}`}">Revoke</button></form>
    </li>`,
    )}
  </ul>`
    : html`<p class="muted small">No keys yet.</p>`}
  <details class="howto">
    <summary>First call</summary>
    <pre class="code" tabindex="0"><code>curl ${origin}/v1/workspaces \\
  -H "Authorization: Bearer $GRAPIM_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"external_id":"customer_123"}'</code></pre>
  </details>
</section>

<section class="card" id="embedding" aria-labelledby="embed-title">
  <div class="card-head"><h2 id="embed-title" class="card-title">Embedding</h2></div>
  <p class="card-sub">The origins whose pages may frame the review desk (one per line, https). Live and test mode each have their own: a test key reads and changes only the test ones, with <code>PUT /v1/settings</code>.</p>
  ${originsForm(team, csrf, 'live', settings.live)}
  ${originsForm(team, csrf, 'test', settings.test)}
</section>`}`,
  });
}

const STATUS_BADGE = { delivered: 'delivered', pending: 'retrying', failed: 'failed' };

export function webhooksPage({ user, csrf, team, isPlatform, endpoints = [], deliveries = [], now }) {
  return layout({
    title: `${team.name} webhooks`,
    user,
    csrf,
    team,
    wide: true,
    crumbs: [{ label: 'Platform', href: `/hub/teams/${team.id}/platform` }, { label: 'Webhooks' }],
    body: html`${head(team, 'platform')}
${!isPlatform
  ? html`<p class="muted">This team is not a platform. <a href="/hub/teams/${team.id}/platform">Set it up</a>.</p>`
  : html`${subnav(team, 'webhooks')}
<section class="card" aria-labelledby="we-title">
  <div class="card-head"><h2 id="we-title" class="card-title">Endpoints</h2></div>
  <p class="card-sub">Created with <code>POST /v1/webhook_endpoints</code>. Deliveries are signed (<code>Grapim-Signature</code>), retried for 24 hours, and an endpoint that fails for 3 days in a row is disabled.</p>
  ${endpoints.length
    ? html`<ul class="list list-flush">${endpoints.map(
      (e) => html`<li class="row">
      <span class="row-main"><span class="row-title mono">${e.url}</span><span class="badge">${e.mode}</span>${e.enabled ? '' : html`<span class="badge badge-danger">disabled</span>`}</span>
      <span class="row-meta">${e.enabled ? html`last success ${time(e.last_success_at, now)}${e.failing_since ? html` · failing since ${time(e.failing_since, now)}` : ''}` : html`disabled ${time(e.disabled_at, now)}: ${e.disabled_reason}`}</span>
    </li>`,
    )}</ul>`
    : html`<p class="muted small">No endpoints yet.</p>`}
</section>
<section class="card" aria-labelledby="wd-title">
  <div class="card-head"><h2 id="wd-title" class="card-title">Recent deliveries</h2><span class="muted">last 100</span></div>
  ${deliveries.length
    ? html`<div class="table-wrap"><table class="table">
    <caption class="sr-only">Webhook deliveries</caption>
    <thead><tr><th scope="col">Event</th><th scope="col" class="hide-sm">Endpoint</th><th scope="col">Status</th><th scope="col" class="num">Attempts</th><th scope="col">Last reply</th><th scope="col">Created</th></tr></thead>
    <tbody>${deliveries.map(
      (d) => html`<tr>
      <th scope="row"><span class="mono">${d.type}</span><span class="sha mono hide-sm">${d.event_id}</span></th>
      <td class="hide-sm mono">${d.url}</td>
      <td><span class="badge">${STATUS_BADGE[d.status] ?? d.status}</span>${d.status === 'pending' && d.next_attempt_at ? html` <span class="muted small">next ${date(d.next_attempt_at)}</span>` : ''}</td>
      <td class="num">${d.attempts}</td>
      <td>${d.last_status ? `HTTP ${d.last_status}` : d.last_error ?? ''}</td>
      <td>${time(d.created_at, now)}</td>
    </tr>`,
    )}</tbody>
  </table></div>`
    : html`<p class="muted small">No deliveries yet.</p>`}
</section>`}`,
  });
}

// Storage: the platform's quota, then each workspace against its own limit
// (review M11). The 100 largest; the API has every workspace's bytes.
function storageCard(st) {
  return html`<section class="card" aria-labelledby="st-title">
  <div class="card-head"><h2 id="st-title" class="card-title">Storage</h2><span class="muted">${mb(st.used)} of ${mb(st.quota)}</span></div>
  <p class="card-sub">Every workspace has its own limit (<code>workspace_storage_mb</code> in <code>PUT /v1/settings</code>, per mode): ${mb(st.limit.live)} live, ${mb(st.limit.test)} test. A write past it, or past the platform's quota, gets 413 <code>storage_limit</code>. Test workspaces share ${mb(st.testCap)} (${mb(st.testUsed)} used).</p>
  ${st.workspaces.length
    ? html`<div class="table-wrap"><table class="table">
    <caption class="sr-only">Storage per workspace</caption>
    <thead><tr><th scope="col">Workspace</th><th scope="col" class="hide-sm">External id</th><th scope="col">Mode</th><th scope="col" class="num">Used</th><th scope="col" class="num">Limit</th><th scope="col" class="num">Share</th></tr></thead>
    <tbody>${st.workspaces.map(
      (w) => html`<tr>
      <th scope="row"><span class="mono">${w.name}</span><span class="sha mono hide-sm">${w.id}</span></th>
      <td class="hide-sm mono">${w.external_id ?? ''}</td>
      <td><span class="badge">${w.mode}</span></td>
      <td class="num">${mb(w.used)}</td>
      <td class="num">${mb(w.limit)}</td>
      <td class="num">${w.limit ? Math.min(100, Math.round((w.used / w.limit) * 100)) : 0}%</td>
    </tr>`,
    )}</tbody>
  </table></div>
  ${st.count > st.workspaces.length ? html`<p class="fine">The ${st.workspaces.length} largest of ${num(st.count)} workspaces. <code>GET /v1/workspaces/:id</code> has each one's <code>usage.bytes</code>.</p>` : ''}`
    : html`<p class="muted small">No workspaces yet.</p>`}
</section>`;
}

export function usagePage({ user, csrf, team, isPlatform, live, test, prices, storage = null }) {
  const rows = (e) => html`<div class="table-wrap"><table class="table">
  <thead><tr><th scope="col">Item</th><th scope="col" class="num">Quantity</th><th scope="col" class="num">Price</th><th scope="col" class="num">Amount</th></tr></thead>
  <tbody>
  ${e.lines.map(
    (l) => html`<tr><th scope="row">${l.item}</th><td class="num">${l.unit === 'GB-month' ? l.quantity.toFixed(3) : num(l.quantity)} <span class="muted small">${l.unit === '1,000 writes' ? 'writes' : l.unit}</span></td><td class="num">${money(l.unit_price, e.currency)} / ${l.unit}</td><td class="num">${money(l.amount, e.currency)}</td></tr>`,
  )}
  <tr><th scope="row">Subtotal</th><td></td><td></td><td class="num">${money(e.subtotal, e.currency)}</td></tr>
  <tr><th scope="row">Monthly minimum</th><td></td><td></td><td class="num">${money(e.minimum, e.currency)}</td></tr>
  <tr><th scope="row" class="strong">Estimated bill</th><td></td><td></td><td class="num strong">${money(e.total, e.currency)}</td></tr>
  </tbody>
</table></div>`;
  return layout({
    title: `${team.name} usage`,
    user,
    csrf,
    team,
    crumbs: [{ label: 'Platform', href: `/hub/teams/${team.id}/platform` }, { label: 'Usage' }],
    body: html`${head(team, 'platform')}
${!isPlatform
  ? html`<p class="muted">This team is not a platform. <a href="/hub/teams/${team.id}/platform">Set it up</a>.</p>`
  : html`${subnav(team, 'usage')}
<section class="card" aria-labelledby="mtd-title">
  <div class="card-head"><h2 id="mtd-title" class="card-title">${live.month}, month to date</h2><span class="muted">live keys</span></div>
  <dl class="stats">
    <div><dt>Active workspaces</dt><dd>${num(live.active_workspaces)}</dd></div>
    <div><dt>Writes</dt><dd>${num(live.writes)}</dd></div>
    <div><dt>API calls</dt><dd>${num(live.api_calls)}</dd></div>
    <div><dt>Storage</dt><dd>${live.storage_gb_months.toFixed(3)} GB-mo</dd></div>
  </dl>
  ${rows(live)}
  <p class="fine">An estimate from the hub's own counts. A workspace is active in a month if it had at least one write. Storage is sampled once a day. The ${money(prices.monthlyMinimum, prices.currency)} minimum applies to live usage.</p>
</section>
<section class="card" aria-labelledby="test-title">
  <div class="card-head"><h2 id="test-title" class="card-title">Test mode</h2><span class="badge">never billed</span></div>
  <dl class="stats">
    <div><dt>Active workspaces</dt><dd>${num(test.active_workspaces)}</dd></div>
    <div><dt>Writes</dt><dd>${num(test.writes)}</dd></div>
    <div><dt>API calls</dt><dd>${num(test.api_calls)}</dd></div>
  </dl>
  <p class="fine">Capped at ${num(prices.testCaps.workspaces)} workspaces, ${num(prices.testCaps.writesPerDay)} writes a day and ${num(prices.testCaps.storageMb)} MB. Each test workspace is deleted ${prices.testCaps.workspaceDays} days after it was created.</p>
</section>
${storage ? storageCard(storage) : ''}`}`,
  });
}
