// The SaaS connector cards on a workspace's page (src/hub/connectors.js):
// connect with a pasted token (with the steps to make one), then the last
// sync, its errors, and Sync now, Test and Disconnect for owners.
//
// The integration's name and error texts come from the service: untrusted,
// escaped like everything else (html.js). The token is never shown.

import { csrfField } from './layout.js';
import { html, time } from './html.js';

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function summaryLine(s) {
  if (!s) return '';
  const parts = [];
  if (s.created) parts.push(`${plural(s.created, 'page')} added`);
  if (s.updated) parts.push(`${plural(s.updated, 'page')} updated`);
  if (s.deleted) parts.push(`${plural(s.deleted, 'page')} removed`);
  if (s.merged) parts.push(`${plural(s.merged, 'edit')} merged`);
  if (s.conflicts?.length) parts.push(`${plural(s.conflicts.length, 'conflict')} kept as copies`);
  return parts.length ? `Last change: ${parts.join(', ')}.` : 'No changes in the last sync.';
}

const STEPS = {
  notion: html`<ol class="steps">
    <li>Open <a href="https://www.notion.so/profile/integrations" target="_blank" rel="noopener noreferrer">Notion's integrations page</a> and choose <strong>New integration</strong>. Pick your Notion workspace, keep the type <strong>Internal</strong>, and save.</li>
    <li>Under <strong>Capabilities</strong>, allow <strong>Read content</strong>, <strong>Update content</strong> and <strong>Insert content</strong>. Copy the <strong>Internal Integration Secret</strong>.</li>
    <li>In Notion, open each page or database agents may work on and choose <strong>•••</strong> &gt; <strong>Connections</strong> &gt; your integration. Pages inside it come along.</li>
    <li>Paste the secret here. Grapim checks it with Notion, stores it encrypted, and never shows it again.</li>
  </ol>`,
};

function card(c, { team, ws, csrf, owner }) {
  const action = (a) => `/hub/teams/${team.id}/workspaces/${ws.id}/connectors/${a}`;
  const root = `saas/${c.name}/`;
  const s = c.summary;
  return html`<section class="card" id="connector-${c.name}" aria-labelledby="connector-${c.name}-title">
  <div class="card-head">
    <h2 id="connector-${c.name}-title" class="card-title">${c.connected ? c.title : `Connect ${c.title}`}</h2>
    ${c.connected ? (c.last_error ? html`<span class="badge badge-warn">Sync failing</span>` : html`<span class="badge badge-ok">Connected</span>`) : ''}
  </div>
  <p class="card-sub">Pages and databases you share with a ${c.title} integration appear in <code>${root}</code> as Markdown files, one per page, with database columns as front matter. When an agent edits one, the change is applied to ${c.title}, recorded like any file change, and can be undone. Changes made in ${c.title} come back every 2 minutes.</p>
  ${c.connected
    ? html`<dl class="stats">
    <div><dt>Integration</dt><dd>${c.account || c.title}</dd></div>
    <div><dt>Pages</dt><dd>${s?.pages ?? '–'}</dd></div>
    <div><dt>Last sync</dt><dd>${c.syncing ? 'Running now' : time(c.last_sync_at)}</dd></div>
  </dl>
  ${c.last_error
    ? html`<p class="notice notice-error" role="alert">The last sync had a problem: ${c.last_error}</p>`
    : html`<p class="fine">${summaryLine(s)}</p>`}
  ${owner
    ? html`<div class="connector-actions">
    <form method="post" action="${action('sync')}">${csrfField(csrf)}<input type="hidden" name="connector" value="${c.name}"><button class="btn btn-sm" type="submit">Sync now</button></form>
    <form method="post" action="${action('test')}">${csrfField(csrf)}<input type="hidden" name="connector" value="${c.name}"><button class="btn btn-sm btn-ghost" type="submit">Test connection</button></form>
    <form method="post" action="${action('disconnect')}" data-confirm="${`Disconnect ${c.title}? Syncing stops at once. The files in ${root} and their history stay.`}">${csrfField(csrf)}<input type="hidden" name="connector" value="${c.name}"><button class="btn btn-sm btn-ghost btn-danger" type="submit">Disconnect</button></form>
  </div>`
    : html`<p class="fine">A team owner can sync, test or disconnect ${c.title}.</p>`}`
    : owner
      ? html`<details class="howto" open>
    <summary>Create an integration</summary>
    ${STEPS[c.name] ?? ''}
  </details>
  <form method="post" action="${action('connect')}" class="inline-form connector-form">
    ${csrfField(csrf)}
    <input type="hidden" name="connector" value="${c.name}">
    <label class="sr-only" for="connector-${c.name}-token">${c.title} integration secret</label>
    <input id="connector-${c.name}-token" name="token" type="password" maxlength="200" placeholder="ntn_…" required autocomplete="off" spellcheck="false">
    <button class="btn btn-primary" type="submit">Test and connect</button>
  </form>`
      : html`<p class="fine">A team owner can connect ${c.title} to this workspace.</p>`}
</section>`;
}

export function connectorCards(connectors, opts) {
  if (!connectors?.length) return '';
  return html`<div id="connectors">${connectors.map((c) => card(c, opts))}</div>`;
}
