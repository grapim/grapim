// Small pieces the team pages share: agent labels, review and tree badges,
// +/- counts, run links, empty states and code blocks. They match the review
// desk's (ui/views/shared.js) so a run reads the same in both.

import { html } from './html.js';

const KINDS = new Set(['claude-code', 'codex', 'cursor', 'mcp', 'http']);
export const kindClass = (k) => `k-${KINDS.has(k) ? k : 'other'}`;

// An agent: a colour swatch for its kind, then its label. Never colour alone.
export const agent = (label, kind) => html`<span class="agent"><span class="swatch ${kindClass(kind)}" aria-hidden="true"></span><span class="agent-name">${label}</span></span>`;

// Hub review state of a synced run. status: pending | stale | approved | rejected.
const REVIEW = { pending: ['Needs review', 'pending'], stale: ['Changed since review', 'warn'], approved: ['Approved', 'ok'], rejected: ['Rejected', 'danger'] };
export const reviewBadge = (status) => {
  const [label, tone] = REVIEW[status] ?? REVIEW.pending;
  return html`<span class="badge badge-${tone}">${label}</span>`;
};

export const delta = (a, r) => html`<span class="delta" aria-label="${`${a} added, ${r} removed`}"><span class="plus">+${a}</span> <span class="minus">−${r}</span></span>`;

export const runHref = (teamId, r) => `/hub/teams/${teamId}/repos/${r.repo_id}/runs/${encodeURIComponent(r.run)}?machine=${encodeURIComponent(r.machine)}`;

// What a run table's hidden columns said, under the run's title on a phone
// (the Lines and Review columns hide below 640 px). Hidden from wider screens.
export const phoneMeta = (...parts) => html`<span class="run-sub-sm show-sm">${parts}</span>`;

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// A shell snippet. hub.js adds the Copy button to every .code block.
export const code = (text, label = 'Command') => html`<pre class="code" tabindex="0" aria-label="${label}"><code>${text}</code></pre>`;

export const emptyState = (title, body, extra = '') => html`<div class="empty"><p class="empty-title">${title}</p><p class="muted">${body}</p>${extra}</div>`;
