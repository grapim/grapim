// The Agents page: which coding agents, versions and models the team's
// computers report, and the tools and services (MCP servers) those agents can
// reach (src/hub/inventory.js). Read only, every member.

import { layout } from './layout.js';
import { agentInfo, brandMark, serviceMark } from './brands.js';
import { date, html, time } from './html.js';
import { code, plural } from './parts.js';
import { head } from './team.js';

const agentName = (a) => agentInfo(a)?.[0] ?? a;

// An agent with its mark (none for Codex: OpenAI asked Simple Icons to remove it).
const agentLabel = (a) => {
  const info = agentInfo(a);
  return html`<span class="agent">${info ? brandMark(info[1]) : ''}<span class="agent-name">${agentName(a)}</span></span>`;
};

// How an MCP server is reached, in words: a command on the computer, or a remote address.
const TRANSPORT = { stdio: 'Local command', http: 'Remote', sse: 'Remote (SSE)' };

// People as a count, with the logins in a title (and for screen readers).
function people(list) {
  if (!list.length) return html`<span class="muted">0</span>`;
  return html`<span title="${list.join(', ')}">${list.length}<span class="sr-only">: ${list.join(', ')}</span></span>`;
}

function target(s) {
  if (s.transport === 'stdio') {
    if (!s.command) return html`<span class="muted">unknown command</span>`;
    return html`<span class="mono">${s.command}${s.package ? ` ${s.package}` : ''}</span>`;
  }
  return s.host ? html`<span class="mono">${s.host}</span>` : html`<span class="muted">unknown address</span>`;
}

// A short list as plain text: the first few, then "and 3 more".
function list(items, render = (x) => html`<span>${x}</span>`) {
  if (!items.length) return html`<span class="muted">Not reported</span>`;
  const shown = items.slice(0, 3);
  return html`<span class="inv-list">${shown.map((x, i) => html`${i ? ', ' : ''}${render(x)}`)}${items.length > 3 ? html` <span class="muted">and ${items.length - 3} more</span>` : ''}</span>`;
}

function agentsTable(team, view, now) {
  return html`<div class="table-wrap">
<table class="table inv-table">
  <caption class="sr-only">Coding agents on ${team.name}'s computers</caption>
  <thead><tr><th scope="col">Agent</th><th scope="col">Versions</th><th scope="col" class="inv-hide">Models</th><th scope="col" class="num">Computers</th><th scope="col" class="num inv-hide-sm">People</th><th scope="col">Last seen</th></tr></thead>
  <tbody>
  ${view.agents.map(
    (a) => html`<tr>
    <th scope="row">${agentLabel(a.agent)}</th>
    <td class="wrap num-text">${list(a.versions)}</td>
    <td class="wrap inv-hide">${list(a.models, (m) => html`<span title="${plural(m.machines, 'computer')}">${m.name}</span>`)}</td>
    <td class="num">${a.machines}</td>
    <td class="num inv-hide-sm">${people(a.people)}</td>
    <td>${time(a.last_seen, now)}</td>
  </tr>`,
  )}
  </tbody>
</table>
</div>`;
}

function serversTable(team, view, now) {
  if (!view.servers.length) {
    return html`<div class="empty"><p class="empty-title">No tools or services yet</p><p class="muted">None of the agents on these computers is set up to reach an MCP server.</p></div>`;
  }
  return html`<div class="table-wrap">
<table class="table inv-table">
  <caption class="sr-only">MCP servers the agents on ${team.name}'s computers can reach</caption>
  <thead><tr><th scope="col">MCP server</th><th scope="col" class="inv-hide-sm">Type</th><th scope="col">Command or address</th><th scope="col" class="inv-hide">Used by</th><th scope="col" class="num">Computers</th><th scope="col" class="num inv-hide-sm">People</th><th scope="col" class="inv-hide-md">First seen</th><th scope="col">Last seen</th></tr></thead>
  <tbody>
  ${view.servers.map(
    (s) => html`<tr>
    <th scope="row"><span class="inv-name">${serviceMark(s.name)}<span class="strong">${s.name}</span>${s.isNew ? html`<span class="badge badge-pending">New this week</span>` : ''}</span></th>
    <td class="inv-hide-sm">${TRANSPORT[s.transport] ?? s.transport}</td>
    <td class="truncate">${target(s)}</td>
    <td class="wrap inv-hide inv-agents">${s.agents.map(agentName).join(', ')}${s.scopes.includes('project') ? html` <span class="muted">${s.scopes.length > 1 ? '(for the user and one project)' : '(one project)'}</span>` : ''}</td>
    <td class="num">${s.machines}</td>
    <td class="num inv-hide-sm">${people(s.people)}</td>
    <td class="inv-hide-md">${date(s.first_seen)}</td>
    <td>${time(s.last_seen, now)}</td>
  </tr>`,
  )}
  </tbody>
</table>
</div>`;
}

export function inventoryPage({ user, csrf, team, view, origin, now = Date.now() }) {
  const empty = !view.machines;
  const fresh = view.servers.filter((s) => s.isNew).length;
  const body = empty
    ? html`<div class="empty">
  <p class="empty-title">No agents reported yet</p>
  <p class="muted">Each computer lists its coding agents and the tools they can reach the next time it sends work to Grapim, once its Grapim CLI is up to date. Only names, versions and addresses are sent, never settings, keys or arguments. <a href="/docs/inventory">What is collected</a></p>
  ${code(`npm install -g grapim@latest\ngrapim sync --hub ${origin}`)}
</div>`
    : html`<dl class="stats inv-stats">
  <div><dt>Computers</dt><dd class="num">${view.machines}</dd></div>
  <div><dt>Coding agents</dt><dd class="num">${view.agents.length}</dd></div>
  <div><dt>Tools and services</dt><dd class="num">${view.servers.length}${fresh ? html` <span class="muted inv-new">${fresh} new this week</span>` : ''}</dd></div>
  <div><dt>People</dt><dd class="num">${view.people}</dd></div>
</dl>
<h2 class="section-title">Coding agents</h2>
${agentsTable(team, view, now)}
<h2 class="section-title">Tools and services your agents can reach</h2>
${serversTable(team, view, now)}
<p class="fine">Each computer reports this when it sends work to Grapim, read from the agents' own settings. Grapim only lists them: nothing here blocks an agent or a tool. Reported since ${date(view.since)}. <a class="link" href="/docs/inventory">What is collected, and what never is</a>.</p>`;
  return layout({
    title: `Agents · ${team.name}`,
    user,
    csrf,
    team,
    wide: true,
    crumbs: [{ label: 'Agents' }],
    body: html`${head(team, 'agents', { title: 'Agents', sub: 'The coding agents on your team’s computers, and the tools and services they can reach.' })}
${body}`,
  });
}
