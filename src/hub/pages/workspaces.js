// Cloud workspaces in the team pages: the list (with create), and one
// workspace's page: a header (size, last activity, Open review desk) and
// tabs for its activity, how to connect an agent, its tokens, integrations,
// and settings (rename, delete).

import { csrfField, layout } from './layout.js';
import { date, html, time } from './html.js';
import { head, reveal } from './team.js';
import { connectorCards } from './connectors.js';
import { icon } from './icons.js';
import { code, delta, emptyState, phoneMeta } from './parts.js';

const mb = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round((n || 0) / 1024))} KB`);
const deskPath = (team, ws) => `/w/${team.id}/${ws.name}/`;

// Rows of the token form's "Limit to folders" (more rules: the platform API, up to 32).
export const SCOPE_ROWS = 5;

// The folder templates a new workspace can start from (src/hub/templates.js).
const TEMPLATE_OPTIONS = [
  ['blank', 'Empty folder'],
  ['agent-team', 'Agent team: code, docs, data, saas'],
  ['research', 'Research: sources, notes, drafts'],
  ['data', 'Data: raw, clean, reports'],
];

// A token's folder rules, as badges; nothing for a whole-workspace token.
const scopeBadges = (scopes) =>
  scopes?.length
    ? html`<span class="scope-list">${scopes.map((r) => html`<span class="badge mono" title="${r.access === 'write' ? 'Read and write' : 'Read only'}">${r.path} · ${r.access}</span>`)}</span>`
    : '';

function notices({ notice, error }) {
  return html`${notice ? html`<p class="notice" role="status">${notice}</p>` : ''}
${error ? html`<p class="notice notice-error" role="alert">${error}</p>` : ''}`;
}

export function workspacesPage({ user, csrf, team, workspaces, limit, notice = null, error = null }) {
  const unlimited = !Number.isFinite(limit);
  const full = !unlimited && workspaces.length >= limit;
  return layout({
    title: `${team.name} workspaces`,
    user,
    csrf,
    team,
    wide: true,
    crumbs: [{ label: 'Workspaces' }],
    body: html`${head(team, 'workspaces', { sub: 'Shared folders your agents read and write from anywhere. Every change is recorded, reviewed in the review desk, and can be undone.' })}
${notices({ notice, error })}
${workspaces.length
  ? html`<div class="table-wrap">
<table class="table">
  <caption class="sr-only">Workspaces of ${team.name}</caption>
  <thead><tr><th scope="col">Workspace</th><th scope="col" class="num">Size</th><th scope="col">Last activity</th><th scope="col" class="hide-sm">Created</th><th scope="col"><span class="sr-only">Open</span></th></tr></thead>
  <tbody>
  ${workspaces.map(
    (w) => html`<tr>
    <th scope="row"><a class="strong" href="/hub/teams/${team.id}/workspaces/${w.id}">${w.name}</a></th>
    <td class="num">${mb(w.bytes)}</td>
    <td>${time(w.last_activity ?? w.created_at)}</td>
    <td class="hide-sm">${date(w.created_at)}</td>
    <td class="cell-action"><a class="btn btn-sm" href="${deskPath(team, w)}">Open</a></td>
  </tr>`,
  )}
  </tbody>
</table>
</div>`
  : emptyState('No workspaces yet', 'Create one below. Agents connect to it with a workspace token.')}
<section class="card card-narrow" aria-labelledby="ws-new-title">
  <div class="card-head">
    <h2 id="ws-new-title" class="card-title">New workspace</h2>
    <span class="muted small">${unlimited ? html`No limit on the <span class="plan">${team.plan}</span> plan` : `${workspaces.length} of ${limit} on the ${team.plan} plan`}</span>
  </div>
  ${full
    ? html`<p class="fine">The ${team.plan} plan includes ${limit} workspace${limit === 1 ? '' : 's'}. An owner can upgrade in <a href="/hub/teams/${team.id}/settings/plan">Settings</a>.</p>`
    : html`<form method="post" action="/hub/teams/${team.id}/workspaces" class="inline-form">
    ${csrfField(csrf)}
    <label class="sr-only" for="ws-name">Workspace name</label>
    <input id="ws-name" name="name" type="text" maxlength="40" placeholder="Name, e.g. research-notes" required autocomplete="off" spellcheck="false">
    <label class="sr-only" for="ws-template">Start with</label>
    <select id="ws-template" name="template">
      ${TEMPLATE_OPTIONS.map(([v, label]) => html`<option value="${v}">${label}</option>`)}
    </select>
    <button class="btn btn-primary" type="submit">Create workspace</button>
  </form>
  <p class="fine">Lowercase letters, digits and dashes. The name is part of the workspace's address. A template adds its folders, each with a short README, as one recorded change you can undo.</p>`}
</section>`,
  });
}

// A segmented control that shows one panel at a time: radio buttons (so the
// keyboard and screen readers know it) and CSS, no script. items: [[key, label, body]].
function switcher(name, label, items, selected = items[0][0]) {
  return html`<div class="segpanels">
  <div class="seg seg-switch" role="radiogroup" aria-label="${label}">
    ${items.map(([k, l]) => html`<label class="seg-item"><input class="sr-only" type="radio" name="${name}" value="${k}" ${k === selected ? html`checked` : ''}>${l}</label>`)}
  </div>
  <div class="switch-panels">${items.map(([k, , body]) => html`<div class="switch-panel" data-panel="${k}">${body}</div>`)}</div>
</div>`;
}

// "Mount as a drive": the WebDAV address and the exact steps per OS
// (src/server/webdav.js, docs/workspaces.md).
function drivePanel(url, ws) {
  const dav = `${url}dav/`;
  const davs = dav.replace(/^https:/, 'davs:').replace(/^http:/, 'dav:');
  return html`<p class="card-sub">Mount as a drive: open this workspace in File Explorer, Finder or Files like a network drive, with nothing to install. Sign in with any user name and a workspace token as the password; a read token mounts it read-only. Every save is recorded as <code>token-name/dav-windows</code> (or <code>dav-macos</code>, <code>dav-linux</code>) and can be undone.</p>
  ${code(dav, 'Drive address')}
  ${switcher('os', 'Operating system', [
    [
      'windows',
      'Windows',
      html`<ol class="steps">
      <li>In File Explorer, right-click <strong>This PC</strong> and choose <strong>Map network drive</strong>.</li>
      <li>Pick a drive letter and paste the address above as the Folder. (Or click <strong>Connect to a Web site that you can use to store your documents and pictures</strong> to add it without a letter.)</li>
      <li>Sign in with any user name, such as <code>grapim</code>, and your workspace token as the password.</li>
    </ol>
    ${code(`# Or in PowerShell, with the token in $env:GRAPIM_WORKSPACE_TOKEN
net use Z: ${dav} /user:grapim $env:GRAPIM_WORKSPACE_TOKEN
# or
grapim mount ${url} Z:`, 'PowerShell')}
    <p class="fine">Windows refuses files over 50 MB on a web drive by default. To raise it, run as administrator <code>reg add HKLM\\SYSTEM\\CurrentControlSet\\Services\\WebClient\\Parameters /v FileSizeLimitInBytes /t REG_DWORD /d 4294967295 /f</code>, then restart the WebClient service. Grapim takes files up to 32 MB each.</p>`,
    ],
    [
      'macos',
      'macOS',
      html`<ol class="steps">
      <li>In Finder, choose <strong>Go</strong> &gt; <strong>Connect to Server</strong> (Command K).</li>
      <li>Paste the address above and click Connect.</li>
      <li>Choose Registered User, enter any name and your workspace token as the password.</li>
    </ol>`,
    ],
    [
      'linux',
      'Linux',
      html`<ol class="steps">
      <li>GNOME Files: <strong>Other Locations</strong> &gt; <strong>Connect to Server</strong>, enter <code>${davs}</code>, then any user name and your token.</li>
      <li>Or davfs2 (<code>sudo apt install davfs2</code>):</li>
    </ol>
    ${code(`echo "${dav} grapim $GRAPIM_WORKSPACE_TOKEN" | sudo tee -a /etc/davfs2/secrets >/dev/null
sudo chmod 600 /etc/davfs2/secrets
sudo mkdir -p /mnt/${ws.name}
sudo mount -t davfs -o uid=$(id -u),gid=$(id -g) ${dav} /mnt/${ws.name}`, 'davfs2')}`,
    ],
  ])}`;
}

function tokenForm({ team, ws, csrf, from, compact = false }) {
  return html`<form method="post" action="/hub/teams/${team.id}/workspaces/${ws.id}/tokens" class="token-form">
    ${csrfField(csrf)}
    <input type="hidden" name="from" value="${from}">
    <div class="inline-form">
      <label class="sr-only" for="wst-name">Token name</label>
      <input id="wst-name" name="name" type="text" maxlength="40" placeholder="Token name, e.g. ci or e2b" required autocomplete="off" spellcheck="false">
      <label class="sr-only" for="wst-scope">Access</label>
      <select id="wst-scope" name="scope">
        <option value="write">Read and write</option>
        <option value="read">Read only</option>
      </select>
      <button class="btn ${compact ? 'btn-primary' : ''}" type="submit">Create token</button>
    </div>
    ${compact
      ? ''
      : html`<details class="howto">
      <summary>Limit to folders</summary>
      <p class="fine">Leave empty for the whole workspace. Otherwise the token sees only these paths: <code>docs/**</code> is the docs folder and everything in it, <code>*</code> matches within one name. The most specific path wins, so <code>docs/**</code> read with <code>docs/drafts/**</code> read and write lets an agent read the docs and change only the drafts.</p>
      <div class="scope-rows">
        ${Array.from({ length: SCOPE_ROWS }, (_, i) => html`<div class="inline-form">
        <label class="sr-only" for="wst-path-${i}">Folder ${i + 1}</label>
        <input id="wst-path-${i}" name="scope_path_${i}" type="text" maxlength="300" placeholder="${i === 0 ? 'e.g. docs/**' : 'Another path'}" autocomplete="off" spellcheck="false">
        <label class="sr-only" for="wst-access-${i}">Access to folder ${i + 1}</label>
        <select id="wst-access-${i}" name="scope_access_${i}">
          <option value="read">Read only</option>
          <option value="write">Read and write</option>
        </select>
      </div>`)}
      </div>
    </details>`}
  </form>`;
}

const revealBox = (revealed) =>
  revealed
    ? reveal({
        id: 'reveal-wstoken',
        title: `Token ${revealed.name} (${revealed.scope}${revealed.scopes?.length ? `, ${revealed.scopes.length} folder rule${revealed.scopes.length === 1 ? '' : 's'}` : ''})`,
        value: revealed.value,
        hint: 'Copy it now: Grapim can’t show it again. Set it as GRAPIM_WORKSPACE_TOKEN where the agent runs.',
      })
    : '';

function connectTab({ team, ws, csrf, url, tokens, revealed }) {
  // The snippets name a token you can see (the one just made, else the newest), never its secret.
  const named = revealed?.name ?? [...tokens].sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0]?.name ?? null;
  const tokenLine = `export GRAPIM_WORKSPACE_TOKEN=gws_…   # ${named ? `the token "${named}"` : 'a write token'}`;
  return html`${revealBox(revealed)}
${!tokens.length && !revealed
  ? html`<section class="card" aria-labelledby="first-token">
  <div class="card-head"><h2 id="first-token" class="card-title">Create a token first</h2></div>
  <p class="card-sub">An agent connects with a workspace token. A write token can also delete, undo, restore, review and branch. It is shown once.</p>
  ${tokenForm({ team, ws, csrf, from: 'connect', compact: true })}
</section>`
  : ''}
<section class="card" aria-labelledby="connect-title">
  <div class="card-head"><h2 id="connect-title" class="card-title">Connect an agent</h2>${named ? html`<span class="muted small">Using the token <span class="mono">${named}</span></span>` : ''}</div>
  ${switcher('connect', 'How to connect', [
    ['https', 'HTTPS', html`<p class="card-sub">Read and write files with plain HTTP requests. Name the agent in X-Grapim-Agent; its runs appear as <code>${named ?? 'token-name'}/agent</code>.</p>
      ${code(`${tokenLine}
curl -X PUT ${url}fs/notes.md \\
  -H "Authorization: Bearer $GRAPIM_WORKSPACE_TOKEN" \\
  -H "X-Grapim-Agent: my-agent" --data-binary @notes.md`, 'HTTPS')}`],
    ['mcp', 'MCP', html`<p class="card-sub">Give Claude Code, Cursor or any MCP client the workspace as a server.</p>
      ${code(`${tokenLine}
claude mcp add --transport http ${ws.name} ${url}mcp \\
  --header "Authorization: Bearer $GRAPIM_WORKSPACE_TOKEN" \\
  --header "X-Grapim-Agent: claude"`, 'MCP')}`],
    ['folder', 'Folder sync', html`<p class="card-sub">Keep a local folder in sync both ways, for agents that work on files on disk.</p>
      ${code(`${tokenLine}
grapim folder ${url} ./${ws.name} --watch`, 'Folder sync')}`],
    ['drive', 'Mount as drive', drivePanel(url, ws)],
  ])}
</section>`;
}

function tokensTab({ team, ws, csrf, owner, tokens, revealed }) {
  return html`<section class="card" id="tokens" aria-labelledby="wst-title">
  <div class="card-head">
    <h2 id="wst-title" class="card-title">Workspace tokens</h2>
  </div>
  <p class="card-sub">A token works for this workspace only. A read token can list and read; a write token can also write, delete, undo, restore, review and branch. Limit it to some folders and it sees nothing else. Its agents appear as <code>token-name/agent</code>. ${owner ? 'You see every token of this workspace.' : 'You see your own tokens.'}</p>
  ${revealBox(revealed)}
  ${tokenForm({ team, ws, csrf, from: 'tokens' })}
  ${tokens.length
    ? html`<ul class="list list-flush">
    ${tokens.map(
      (t) => html`<li class="row">
      <span class="row-main"><span class="row-title">${t.name}</span><span class="badge">${t.scope}</span>${scopeBadges(t.scopes)}<span class="muted mono">…${t.hint}</span></span>
      <span class="row-meta">${owner ? html`${t.owner || 'unknown'} · ` : ''}used ${time(t.last_used_at)}</span>
      <form method="post" action="/hub/teams/${team.id}/workspaces/${ws.id}/tokens/${t.id}/revoke" data-confirm="${`Revoke the token ${t.name}? Agents using it stop working at once.`}">${csrfField(csrf)}<button class="btn btn-ghost btn-sm btn-danger" type="submit" aria-label="${`Revoke token ${t.name}`}">Revoke</button></form>
    </li>`,
    )}
  </ul>`
    : ''}
</section>`;
}

function settingsTab({ team, ws, csrf, owner }) {
  return html`<section class="card" id="rename" aria-labelledby="rename-title">
  <div class="card-head">
    <h2 id="rename-title" class="card-title">Rename</h2>
  </div>
  <p class="card-sub">The address changes to the new name. Tokens keep working; agents and synced folders need the new address.</p>
  <form method="post" action="/hub/teams/${team.id}/workspaces/${ws.id}/rename" class="inline-form">
    ${csrfField(csrf)}
    <label class="sr-only" for="rename-name">New name</label>
    <input id="rename-name" name="name" type="text" maxlength="40" value="${ws.name}" required autocomplete="off" spellcheck="false">
    <button class="btn" type="submit">Rename</button>
  </form>
</section>
${owner
  ? html`<section class="card card-danger" id="delete" aria-labelledby="delete-title">
  <div class="card-head">
    <h2 id="delete-title" class="card-title">Delete workspace</h2>
  </div>
  <p class="card-sub">Its address and every token stop working at once. The files are kept in the hub's trash for now; they still count toward the team's storage until purged.</p>
  <form method="post" action="/hub/teams/${team.id}/workspaces/${ws.id}/delete" class="inline-form">
    ${csrfField(csrf)}
    <label for="delete-confirm">Type <code>${ws.name}</code> to confirm</label>
    <input id="delete-confirm" name="confirm" type="text" maxlength="40" required autocomplete="off" spellcheck="false">
    <button class="btn btn-danger" type="submit">Delete workspace</button>
  </form>
</section>`
  : html`<p class="fine">Only a team owner can delete this workspace.</p>`}`;
}

const REVIEW = { pending: ['Needs approval', 'pending'], approved: ['Approved', 'ok'], rejected: ['Rejected', 'danger'] };

function activityTab({ team, ws, activity }) {
  const desk = deskPath(team, ws);
  if (activity?.error) return html`<p class="notice" role="status">${activity.error}</p>`;
  const runs = activity?.runs ?? [];
  if (!runs.length) {
    return emptyState('No agent has written here yet', 'Runs show up here once an agent connects with a token and writes a file.', html`<p class="empty-actions"><a class="btn" href="/hub/teams/${team.id}/workspaces/${ws.id}/connect">Connect an agent</a></p>`);
  }
  return html`<div class="table-wrap">
<table class="table">
  <caption class="sr-only">Recent runs in ${ws.name}, newest first</caption>
  <thead><tr><th scope="col">Run</th><th scope="col" class="num hide-sm">Files</th><th scope="col" class="num hide-sm">Lines</th><th scope="col" class="hide-sm">Review</th><th scope="col">Last change</th></tr></thead>
  <tbody>
  ${runs.map((r) => {
    const [label, tone] = REVIEW[r.review] ?? REVIEW.pending;
    return html`<tr>
    <th scope="row" class="cell-run"><a class="run-link" href="${`${desk}#/runs/${encodeURIComponent(r.run)}`}" title="${r.intent || r.label}"><span class="run-intent">${r.intent || r.label}</span></a><span class="run-sub">${r.intent ? html`<span class="agent-name">${r.label}</span>` : html`<span class="muted">No prompt recorded</span>`}${phoneMeta(delta(r.added, r.removed), html`<span class="badge badge-${tone}">${label}</span>`)}</span></th>
    <td class="num hide-sm">${r.files}</td>
    <td class="num hide-sm">${delta(r.added, r.removed)}</td>
    <td class="hide-sm"><span class="badge badge-${tone}">${label}</span></td>
    <td>${time(r.last_ts)}</td>
  </tr>`;
  })}
  </tbody>
</table>
</div>
${activity.changes?.length
  ? html`<h2 class="section-title">Recent changes</h2>
<ul class="feed feed-card">${activity.changes.map(
    (c) => html`<li class="feed-row"><span class="feed-what"><span class="agent-name">${c.label || c.run}</span> <span class="muted">changed</span> <a class="mono link" href="${`${desk}#/files/${c.path.split('/').map(encodeURIComponent).join('/')}`}">${c.path}</a> ${c.added === null ? '' : delta(c.added ?? 0, c.removed ?? 0)}</span>${time(c.ts)}</li>`,
  )}</ul>`
  : ''}
<p class="fine">Review, undo, restore and branch these runs in the <a href="${desk}">review desk</a>.</p>`;
}

export const WORKSPACE_TABS = ['activity', 'connect', 'tokens', 'integrations', 'settings'];

export function workspacePage({ user, csrf, team, role, ws, tokens, origin, connectors = [], activity = null, lastActivity = null, tab = 'activity', revealed = null, notice = null, error = null, toast = null }) {
  const owner = role === 'owner';
  const url = `${origin}${deskPath(team, ws)}`;
  const base = `/hub/teams/${team.id}/workspaces/${ws.id}`;
  const tabs = [
    ['activity', 'Activity', base],
    ['connect', 'Connect', `${base}/connect`],
    ['tokens', 'Tokens', `${base}/tokens`],
    ...(connectors.length ? [['integrations', 'Integrations', `${base}/integrations`]] : []),
    ['settings', 'Settings', `${base}/settings`],
  ];
  const current = tabs.some(([k]) => k === tab) ? tab : 'activity';
  const body = {
    activity: () => activityTab({ team, ws, activity }),
    connect: () => connectTab({ team, ws, csrf, url, tokens, revealed }),
    tokens: () => tokensTab({ team, ws, csrf, owner, tokens, revealed }),
    integrations: () => connectorCards(connectors, { team, ws, csrf, owner }),
    settings: () => settingsTab({ team, ws, csrf, owner }),
  }[current]();
  return layout({
    title: `${ws.name} · ${team.name}`,
    user,
    csrf,
    team,
    // One width for every tab, so the heading and tabs stay put when you switch.
    wide: 'mid',
    toast,
    crumbs: [{ label: 'Workspaces', href: `/hub/teams/${team.id}/workspaces` }, { label: ws.name }],
    body: html`${head(team, 'workspaces', {
      title: ws.name,
      sub: html`<span class="num">${mb(ws.bytes)}</span> · created ${date(ws.created_at)} · last activity ${time(lastActivity ?? ws.created_at)}`,
      actions: html`<a class="btn btn-primary" href="${deskPath(team, ws)}">Open review desk ${icon('external')}</a>`,
    })}
<nav class="tabs" aria-label="Workspace">
  ${tabs.map(([k, label, href]) => html`<a class="tab" href="${href}" ${k === current ? html`aria-current="page"` : ''}>${label}${k === 'tokens' && tokens.length ? html` <span class="num muted">${tokens.length}</span>` : ''}</a>`)}
</nav>
${notices({ notice, error })}
${body}`,
  });
}


