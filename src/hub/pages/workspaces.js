// Cloud workspaces in the team pages: the list (with create), and one
// workspace's page (open it, connect agents, tokens, rename, delete).

import { csrfField, layout } from './layout.js';
import { date, html, time } from './html.js';
import { head, reveal } from './team.js';

const mb = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round((n || 0) / 1024))} KB`);
const deskPath = (team, ws) => `/w/${team.id}/${ws.name}/`;

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
    crumbs: [{ label: 'Workspaces' }],
    body: html`${head(team, 'workspaces')}
${notices({ notice, error })}
<section class="card" aria-labelledby="ws-title">
  <div class="card-head">
    <h2 id="ws-title" class="card-title">Workspaces</h2>
    <span class="muted">${workspaces.length} of ${unlimited ? 'unlimited' : limit} on the ${team.plan} plan</span>
  </div>
  <p class="card-sub">A workspace is a folder that lives on the hub. Any agent, anywhere, reads and writes it with a workspace token, over HTTPS or MCP. Every write is recorded, can be reviewed in the desk, and can be undone.</p>
  ${workspaces.length
    ? html`<ul class="list list-flush">
    ${workspaces.map(
      (w) => html`<li class="row">
      <span class="row-main"><a class="row-title strong" href="/hub/teams/${team.id}/workspaces/${w.id}">${w.name}</a></span>
      <span class="row-meta hide-sm">${mb(w.bytes)} · created ${date(w.created_at)}</span>
      <a class="btn btn-sm" href="${deskPath(team, w)}">Open</a>
    </li>`,
    )}
  </ul>`
    : html`<p class="muted small">No workspaces yet.</p>`}
  ${full
    ? html`<p class="fine">The ${team.plan} plan includes ${limit} workspace${limit === 1 ? '' : 's'}. An owner can upgrade in <a href="/hub/teams/${team.id}/settings#billing">Settings</a>.</p>`
    : html`<form method="post" action="/hub/teams/${team.id}/workspaces" class="inline-form">
    ${csrfField(csrf)}
    <label class="sr-only" for="ws-name">Workspace name</label>
    <input id="ws-name" name="name" type="text" maxlength="40" placeholder="Name, e.g. research-notes" required autocomplete="off" spellcheck="false">
    <button class="btn btn-primary" type="submit">Create workspace</button>
  </form>
  <p class="fine">Lowercase letters, digits and dashes. The name is part of the workspace's address.</p>`}
</section>`,
  });
}

export function workspacePage({ user, csrf, team, role, ws, tokens, origin, revealed = null, notice = null, error = null }) {
  const owner = role === 'owner';
  const url = `${origin}${deskPath(team, ws)}`;
  return layout({
    title: `${ws.name} · ${team.name}`,
    user,
    csrf,
    team,
    crumbs: [{ label: 'Workspaces', href: `/hub/teams/${team.id}/workspaces` }, { label: ws.name }],
    body: html`${head(team, 'workspaces')}
${notices({ notice, error })}
<section class="card" aria-labelledby="open-title">
  <div class="card-head">
    <h2 id="open-title" class="card-title">${ws.name}</h2>
    <a class="btn btn-primary btn-sm" href="${deskPath(team, ws)}">Open review desk</a>
  </div>
  <dl class="stats">
    <div><dt>Size</dt><dd>${mb(ws.bytes)}</dd></div>
    <div><dt>Created</dt><dd>${date(ws.created_at)}</dd></div>
  </dl>
  <details class="howto" open>
    <summary>Connect an agent</summary>
    <pre class="code" tabindex="0"><code>export GRAPIM_WORKSPACE_TOKEN=gws_…   # a write token, created below

# Files over HTTPS
curl -X PUT ${url}fs/notes.md \\
  -H "Authorization: Bearer $GRAPIM_WORKSPACE_TOKEN" \\
  -H "X-Grapim-Agent: my-agent" --data-binary @notes.md

# MCP (Claude Code)
claude mcp add --transport http ${ws.name} ${url}mcp \\
  --header "Authorization: Bearer $GRAPIM_WORKSPACE_TOKEN" \\
  --header "X-Grapim-Agent: claude"

# Keep a local folder in sync
grapim folder ${url} ./${ws.name} --watch</code></pre>
  </details>
</section>

<section class="card" id="tokens" aria-labelledby="wst-title">
  <div class="card-head">
    <h2 id="wst-title" class="card-title">Workspace tokens</h2>
  </div>
  <p class="card-sub">A token works for this workspace only. A read token can list and read; a write token can also write, delete, undo, restore, review and branch. Its agents appear as <code>token-name/agent</code>. ${owner ? 'You see every token of this workspace.' : 'You see your own tokens.'}</p>
  ${revealed
    ? reveal({ id: 'reveal-wstoken', title: `Token ${revealed.name} (${revealed.scope})`, value: revealed.value, hint: 'Copy it now. Only a hash is stored, so it cannot be shown again. Put it in GRAPIM_WORKSPACE_TOKEN where the agent runs.' })
    : ''}
  <form method="post" action="/hub/teams/${team.id}/workspaces/${ws.id}/tokens" class="inline-form">
    ${csrfField(csrf)}
    <label class="sr-only" for="wst-name">Token name</label>
    <input id="wst-name" name="name" type="text" maxlength="40" placeholder="Token name, e.g. ci or e2b" required autocomplete="off" spellcheck="false">
    <label class="sr-only" for="wst-scope">Access</label>
    <select id="wst-scope" name="scope">
      <option value="write">Read and write</option>
      <option value="read">Read only</option>
    </select>
    <button class="btn" type="submit">Create token</button>
  </form>
  ${tokens.length
    ? html`<ul class="list list-flush">
    ${tokens.map(
      (t) => html`<li class="row">
      <span class="row-main"><span class="row-title">${t.name}</span><span class="badge">${t.scope}</span><span class="muted mono">…${t.hint}</span></span>
      <span class="row-meta">${owner ? html`${t.owner || 'unknown'} · ` : ''}used ${time(t.last_used_at)}</span>
      <form method="post" action="/hub/teams/${team.id}/workspaces/${ws.id}/tokens/${t.id}/revoke" data-confirm="${`Revoke the token ${t.name}? Agents using it stop working at once.`}">${csrfField(csrf)}<button class="btn btn-ghost btn-sm btn-danger" type="submit" aria-label="${`Revoke token ${t.name}`}">Revoke</button></form>
    </li>`,
    )}
  </ul>`
    : ''}
</section>

<section class="card" id="rename" aria-labelledby="rename-title">
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
    <button class="btn btn-sm btn-danger" type="submit">Delete</button>
  </form>
</section>`
  : ''}`,
  });
}
