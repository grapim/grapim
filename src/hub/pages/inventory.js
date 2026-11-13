// The Agents page: which coding agents, versions, models and MCP servers the
// team's machines report (src/hub/inventory.js). Read only, every member.

import { layout } from './layout.js';
import { date, html, time } from './html.js';
import { code, plural } from './parts.js';
import { head } from './team.js';

const AGENT_NAMES = { claude: 'Claude Code', codex: 'Codex CLI', cursor: 'Cursor', gemini: 'Gemini CLI' };
const agentName = (a) => AGENT_NAMES[a] ?? a;

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
  return s.host ? html`<span class="mono">${s.host}</span>` : html`<span class="muted">unknown host</span>`;
}

function agentsTable(team, view, now) {
  return html`<div class="table-wrap">
<table class="table inv-table">
  <caption class="sr-only">Coding agents on ${team.name}'s machines</caption>
  <thead><tr><th scope="col">Agent</th><th scope="col">Versions</th><th scope="col" class="inv-hide">Models</th><th scope="col" class="num">Machines</th><th scope="col" class="num inv-hide-sm">People</th><th scope="col">Last seen</th></tr></thead>
  <tbody>
  ${view.agents.map(
    (a) => html`<tr>
    <th scope="row"><span class="strong">${agentName(a.agent)}</span></th>
    <td class="wrap">${a.versions.length ? html`<span class="inv-chips">${a.versions.map((v) => html`<span class="badge badge-outline mono">${v}</span>`)}</span>` : html`<span class="muted">not reported</span>`}</td>
    <td class="wrap inv-hide">${a.models.length ? html`<span class="inv-chips">${a.models.map((m) => html`<span class="badge mono" title="${`${plural(m.machines, 'machine')}`}">${m.name}</span>`)}</span>` : html`<span class="muted">not reported</span>`}</td>
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
    return html`<div class="empty"><p class="empty-title">No MCP servers configured</p><p class="muted">None of the agents on these machines has an MCP server in its user or project config.</p></div>`;
  }
  return html`<div class="table-wrap">
<table class="table inv-table">
  <caption class="sr-only">MCP servers configured on ${team.name}'s machines</caption>
  <thead><tr><th scope="col">Server</th><th scope="col" class="inv-hide-sm">Transport</th><th scope="col">Command or host</th><th scope="col" class="inv-hide">Agents</th><th scope="col" class="num">Machines</th><th scope="col" class="num inv-hide-sm">People</th><th scope="col" class="inv-hide-md">First seen</th><th scope="col">Last seen</th></tr></thead>
  <tbody>
  ${view.servers.map(
    (s) => html`<tr>
    <th scope="row"><span class="inv-name"><span class="strong">${s.name}</span>${s.isNew ? html`<span class="badge badge-pending">New this week</span>` : ''}</span></th>
    <td class="inv-hide-sm"><span class="badge badge-outline">${s.transport}</span></td>
    <td class="truncate">${target(s)}</td>
    <td class="wrap inv-hide inv-agents">${s.agents.map(agentName).join(', ')}${s.scopes.includes('project') ? html` <span class="muted">${s.scopes.length > 1 ? '(user and project)' : '(project)'}</span>` : ''}</td>
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
  <p class="empty-title">No agent inventory yet</p>
  <p class="muted">Each machine reports which coding agents and MCP servers it has the next time it syncs, after its Grapim CLI is updated. Only names, versions, transports and hosts are sent, never settings, keys or arguments. <a href="/docs/inventory">What is collected</a></p>
  ${code(`npm install -g grapim@latest\ngrapim sync --hub ${origin}`)}
</div>`
    : html`<dl class="stats inv-stats">
  <div><dt>Machines</dt><dd class="num">${view.machines}</dd></div>
  <div><dt>Agents</dt><dd class="num">${view.agents.length}</dd></div>
  <div><dt>MCP servers</dt><dd class="num">${view.servers.length}${fresh ? html` <span class="muted inv-new">${fresh} new this week</span>` : ''}</dd></div>
  <div><dt>People</dt><dd class="num">${view.people}</dd></div>
</dl>
<h2 class="section-title">Coding agents</h2>
${agentsTable(team, view, now)}
<h2 class="section-title">MCP servers</h2>
${serversTable(team, view, now)}
<p class="fine">Reported by each machine on <code>grapim sync</code>, from the agents' own config files and the hooks Grapim installs. Discovery only: nothing here blocks an agent or a server. Machines report since ${date(view.since)}. <a class="link" href="/docs/inventory">What is collected, and what never is</a>.</p>`;
  return layout({
    title: `Agents · ${team.name}`,
    user,
    csrf,
    team,
    wide: true,
    crumbs: [{ label: 'Agents' }],
    body: html`${head(team, 'agents', { title: 'Agents', sub: 'Which coding agents your team runs, their versions and models, and the MCP servers they can connect to.' })}
${body}`,
  });
}
