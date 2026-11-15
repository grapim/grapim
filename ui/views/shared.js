// Small pieces every view uses: times, agent colours, badges, icons, empty
// states and errors.

import { html, raw } from '../app.js';

// ---------------------------------------------------------------- time

const RTF = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'narrow' });
export function ago(ts, now = Date.now()) {
  if (!ts) return '—';
  const s = Math.round((now - ts) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
export function until(ts, now = Date.now()) {
  const m = Math.round((ts - now) / 60000);
  return m <= 0 ? 'now' : RTF.format(m, 'minute');
}
const EXACT = new Intl.DateTimeFormat(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
export const exact = (ts) => (ts ? EXACT.format(new Date(ts)) : '');
export const clock = (ts) => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
// A feed stamp: the time of day for today, the date for anything older, so an
// event from Monday never reads like one from a minute ago.
export const stamp = (ts, now = Date.now()) =>
  (new Date(ts).toDateString() === new Date(now).toDateString() ? clock(ts) : new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));

// <time> with a relative label and the exact time on hover. The app refreshes
// every [data-ago] once a minute without re-rendering the view.
export const when = (ts, cls = '') =>
  ts ? html`<time class="${cls}" datetime="${new Date(ts).toISOString()}" title="${exact(ts)}" data-ago="${ts}">${ago(ts)}</time>` : html`<span class="muted">—</span>`;

// ---------------------------------------------------------------- agents

// Each agent gets one of 8 colours, in the order agents first appear, so the
// same agent keeps its colour on every screen. Labels never rely on colour
// alone: the label text is always next to it.
const order = new Map();
export function registerAgents(labels) {
  for (const l of labels) if (l && l !== 'outside agents' && !order.has(l)) order.set(l, order.size);
}
export function colorOf(label) {
  if (!label || label === 'outside agents') return 'var(--outside)';
  if (!order.has(label)) order.set(label, order.size);
  return `var(--a${order.get(label) % 8})`;
}
export function agentChip(label, { title } = {}) {
  if (!label) return html`<span class="muted">—</span>`;
  if (label === 'outside agents') return html`<span class="agent outside" title="${title || 'Changed by a person or a shell command, not by a recorded agent edit'}"><i class="dot"></i><span>outside agents</span></span>`;
  const parts = label.split(' ');
  // An undo run: "undo claude 0c4d5e6f" reads as "undo 0c4d5e6f", in the undone agent's colour.
  if (parts[0] === 'undo' && parts.length > 1) {
    return html`<span class="agent" style="--c:${raw(colorOf(parts.slice(1).join(' ')))}" title="${title || label}">${raw('<svg class="icon sm" viewBox="0 0 16 16" aria-hidden="true" style="color:var(--c)"><path d="M5.5 3 2.5 6l3 3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.5 6h7a4 4 0 0 1 0 8H7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>')}<span>undo</span><span class="id">${parts.at(-1)}</span></span>`;
  }
  // A restore run: "restore src/app.js 1a2b3c4d" reads as "restore 1a2b3c4d" (the version).
  if (parts[0] === 'restore' && parts.length > 2 && /^[0-9a-f]{8}$/.test(parts.at(-1))) {
    return html`<span class="agent" style="--c:var(--outside)" title="${title || label}">${icon('history', 'sm')}<span>restore</span><span class="id">${parts.at(-1)}</span></span>`;
  }
  const kind = parts.length > 1 ? parts.slice(0, -1).join(' ') : label;
  const id = parts.length > 1 ? parts.at(-1) : '';
  return html`<span class="agent" style="--c:${raw(colorOf(label))}" title="${title || label}"><i class="dot"></i><span>${kind}</span>${id ? html`<span class="id">${id}</span>` : ''}</span>`;
}
// The short id a human types to confirm an undo: the label's id, 4 characters
// ("claude 1a2b3c4d" -> "1a2b"). A label without an id, like the hub's
// "e2b/writer" or "template:research", uses its last name part instead.
export function shortId(label) {
  const last = label.split(' ').at(-1) || label;
  if (/\d/.test(last) && /^[0-9a-z-]+$/i.test(last)) return last.slice(0, 4);
  return last.split(/[/:]/).filter(Boolean).at(-1) || last;
}

// ---------------------------------------------------------------- status

const REVIEW = { pending: 'Needs approval', approved: 'Approved', rejected: 'Rejected' };
export const reviewBadge = (r) => html`<span class="badge ${r?.status || 'pending'}">${REVIEW[r?.status] || 'Needs approval'}</span>`;

const TREE = { all: ['In tree', ''], some: ['Partly in tree', 'warn'], none: ['Not in tree', ''] };
export const treeBadge = (s) => {
  const [t, c] = TREE[s] || ['Unknown', ''];
  return html`<span class="badge ${c} outline" title="${treeTitle(s)}">${t}</span>`;
};
const treeTitle = (s) => ({
  all: 'Every line this run wrote is still in the working tree.',
  some: 'Some of its lines were changed or removed since, by another agent or by an undo.',
  none: 'None of its changes are in the working tree any more.',
}[s] || '');
export const treeText = (s) => (TREE[s] || ['?'])[0];

export const plusMinus = (a, r) => html`<span class="plusminus" aria-label="${a} added, ${r} removed"><span class="add">+${a}</span><span class="del">−${r}</span></span>`;

// ---------------------------------------------------------------- icons (functional only)

const P = {
  live: '<circle cx="8" cy="8" r="2" fill="currentColor"/><path d="M4.5 4.5a5 5 0 0 0 0 7M11.5 4.5a5 5 0 0 1 0 7M2.6 2.6a7.6 7.6 0 0 0 0 10.8M13.4 2.6a7.6 7.6 0 0 1 0 10.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  runs: '<path d="M2.5 4h11M2.5 8h11M2.5 12h7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  files: '<path d="M2.5 4.5v7a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H8L6.5 3.5h-3a1 1 0 0 0-1 1Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>',
  chev: '<path d="m4.5 6 3.5 3.5L11.5 6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  right: '<path d="m6 4 4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  check: '<path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  x: '<path d="m4.5 4.5 7 7m0-7-7 7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  dotc: '<circle cx="8" cy="8" r="3.5" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  branch: '<circle cx="4.5" cy="3.5" r="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="4.5" cy="12.5" r="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="11.5" cy="5" r="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M4.5 5v6M11.5 6.5c0 3-7 2-7 4.5" fill="none" stroke="currentColor" stroke-width="1.4"/>',
  undo: '<path d="M5.5 3 2.5 6l3 3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.5 6h7a4 4 0 0 1 0 8H7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  search: '<circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="m10.5 10.5 3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  worktree: '<path d="M2.5 4.5v7a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H8L6.5 3.5h-3a1 1 0 0 0-1 1Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>',
  file: '<path d="M4 2.5h5l3 3v8H4z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M9 2.5v3h3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>',
  lock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" stroke-width="1.4"/>',
  info: '<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 7.5v3.5M8 5v.01" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  alert: '<path d="M8 2.5 14 13H2z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M8 6.5v3M8 11.3v.01" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  sun: '<circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  moon: '<path d="M13 9.5A5.5 5.5 0 1 1 6.5 3a4.5 4.5 0 0 0 6.5 6.5Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>',
  system: '<rect x="2" y="3" width="12" height="8.5" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M6 13.5h4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.5 3.5v-.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h.5" fill="none" stroke="currentColor" stroke-width="1.4"/>',
  history: '<path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M2.5 2.5v2.5H5M8 5v3l2 1.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
  download: '<path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  back: '<path d="M10 4 6 8l4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
};
export const icon = (name, cls = '') => raw(`<svg class="icon ${cls}" viewBox="0 0 16 16" aria-hidden="true" focusable="false">${P[name] || ''}</svg>`);

// ---------------------------------------------------------------- blocks

// A cloud workspace on the hub is served under /w/<team>/<name>/; a local
// `grapim serve` is served at the root. Empty states say different things.
const WS_PATH = /^\/w\/([^/]+)\/([^/]+)\//.exec(location.pathname);
export const IS_CLOUD = !!WS_PATH;
const syncCmd = () => `grapim folder ${location.origin}${WS_PATH[0]} ./${decodeURIComponent(WS_PATH[2])} --watch`;
const tokensLink = () => html`<a href="/hub/teams/${WS_PATH[1]}/workspaces">workspace page in the hub</a>`;

// What to do so agents show up: hooks in a local repo, a token for a cloud workspace.
export const setupHint = (what) =>
  IS_CLOUD
    ? {
        body: html`${what} Create a workspace token on the ${tokensLink()}, then connect an agent over HTTPS or MCP, or sync a local folder.`,
        cmd: syncCmd(),
      }
    : { body: html`${what} Run <code>grapim init</code> in your repo, then start a Claude Code session.`, cmd: 'grapim init' };

// An empty state always names the exact next command.
export const empty = (title, body, cmd) => html`
  <div class="empty">
    <h3>${title}</h3>
    <p>${body}</p>
    ${cmd ? html`<div class="cmd"><span class="muted" aria-hidden="true">$</span><code title="${cmd}">${cmd}</code><button class="icon-btn sm" type="button" data-copy-text="${cmd}" aria-label="Copy the command" title="Copy">${icon('copy', 'sm')}</button></div>` : ''}
  </div>`;

// A human error, with a retry if one makes sense.
export function errorBlock(err, { title = 'This didn’t load', retry = true } = {}) {
  const msg = err?.message || 'Something went wrong.';
  const parts = String(msg).split(/`([^`]+)`/);
  return html`
    <div class="error" role="alert">
      ${icon('alert')}
      <div>
        <h3>${title}</h3>
        <p>${parts.map((p, i) => (i % 2 ? html`<code>${p}</code>` : p))}</p>
        ${retry ? html`<button class="btn sm" type="button" data-action="retry">Try again</button>` : ''}
      </div>
    </div>`;
}

export const sk = (w, h = 12, style = '') => html`<span class="sk" style="width:${w};height:${h}px;${raw(style)}"></span>`;

// Turns `code` spans in a message into <code>.
export const withCode = (s) => String(s).split(/`([^`]+)`/).map((p, i) => (i % 2 ? html`<code class="inline-code">${p}</code>` : p));

export const pluralize = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// The worktree the file APIs read from by default: the one the server runs in.
export const isMainWorktree = (ov, wt) => !ov || !wt || wt === (ov.worktree ?? ov.worktrees?.[0]?.name ?? ov.repo);
// The Files view can open any worktree the server lists (?wt=), so a file in
// another one gets that query; one it does not know gets none (null).
export const worktreeQuery = (ov, wt) => (isMainWorktree(ov, wt) ? '' : ov.worktrees?.some((w) => w.name === wt) ? `wt=${encodeURIComponent(wt)}` : null);

// What to call a run: its intent, or for an undo run what it undid, for a
// restore run which file went back to which version.
export function runTitle(r) {
  if (r.intent) return r.intent;
  if (r.run?.startsWith('undo:')) return `Undo of ${r.label.replace(/^undo /, '')}`;
  const m = r.run?.startsWith('restore:') && /^restore (.+) ([0-9a-f]{8})$/.exec(r.label || '');
  return m ? `Restore ${m[1]} to version ${m[2]}` : null;
}
