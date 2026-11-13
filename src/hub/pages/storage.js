// The settings card "Storage" (owner only): where the team's workspace files
// are kept, a move in progress, and the form to bring your own bucket.
// Secrets are never put back into the page: the credential fields are always empty.

import { csrfField } from './layout.js';
import { date, html, time } from './html.js';

const PLACEHOLDER = {
  bucket: 'grapim-workspaces',
  prefix: 'grapim',
  endpoint: 'https://<account_id>.r2.cloudflarestorage.com',
};

function where(cfg, providers) {
  return html`<dl class="stats">
    <div><dt>Provider</dt><dd>${providers[cfg.provider] ?? cfg.provider}</dd></div>
    ${cfg.account ? html`<div><dt>Account</dt><dd class="mono truncate">${cfg.account}</dd></div>` : ''}
    <div><dt>${cfg.provider === 'azure' ? 'Container' : 'Bucket'}</dt><dd class="mono truncate">${cfg.bucket}</dd></div>
    <div><dt>Prefix</dt><dd class="mono truncate">${cfg.prefix ? `${cfg.prefix}/` : '(none)'}</dd></div>
    ${cfg.region ? html`<div><dt>Region</dt><dd class="mono">${cfg.region}</dd></div>` : ''}
  </dl>
  <p class="fine">Endpoint <span class="mono">${cfg.endpoint}</span></p>`;
}

function moveBlock({ team, csrf, status, providers }) {
  const m = status.move;
  const target = m.to === 'hub' ? "the hub's storage" : providers[m.to] ?? m.to;
  const pct = m.total ? Math.floor((m.done / m.total) * 100) : 0;
  const label = m.pass === 0 ? `Copying: ${m.done} of ${m.total} objects` : `Checking (pass ${m.pass + 1}): ${m.done} of ${m.total} objects`;
  return html`<div class="storage-move" role="status">
    <p class="strong">${m.state === 'failed' ? `The move to ${target} stopped` : `Moving to ${target}`}</p>
    <progress max="100" value="${pct}" aria-label="${label}">${pct}%</progress>
    <p class="fine">${label}, ${m.copied} copied in this pass. Started ${time(m.started_at)}, last progress ${time(m.updated_at)}. Reload to see more.</p>
    <p class="fine">Until it finishes, the team keeps using its current storage: new versions are written to both, and nothing switches until every object is in the new store.</p>
    ${m.state === 'failed' ? html`<p class="notice notice-error" role="alert">${m.error || 'The move failed.'}</p>` : ''}
    <div class="inline-form">
      ${m.state === 'failed' ? html`<form method="post" action="/hub/teams/${team.id}/storage/retry">${csrfField(csrf)}<button class="btn btn-sm btn-primary" type="submit">Retry</button></form>` : ''}
      <form method="post" action="/hub/teams/${team.id}/storage/cancel" data-confirm="Cancel the move? The team keeps its current storage; objects already copied stay where they are.">${csrfField(csrf)}<button class="btn btn-sm" type="submit">Cancel move</button></form>
    </div>
  </div>`;
}

// only: the providers a field applies to (data-only, read by hub.css), or all.
function field(id, label, hint, { value = '', placeholder = '', type = 'text', required = false, only = null } = {}) {
  return html`<div class="storage-field" ${only ? html`data-only="${only}"` : ''}>
    <label for="${id}">${label}</label>
    <input id="${id}" name="${id.replace(/^storage-/, '').replace(/-/g, '_')}" type="${type}" value="${value}" placeholder="${placeholder}" autocomplete="off" spellcheck="false" ${required ? html`required` : ''}>
    ${hint ? html`<span class="fine">${hint}</span>` : ''}
  </div>`;
}

// A hint for one provider only.
const per = (only, text) => html`<span class="fine" data-only="${only}">${text}</span>`;

// The form shows only the fields of the chosen provider (hub.css, from the
// select's checked option; without :has every field shows, with its hint).
function form({ team, csrf, status, providers, values }) {
  const v = { provider: 's3', bucket: '', prefix: '', endpoint: '', region: '', account: '', ...values };
  return html`<form method="post" action="/hub/teams/${team.id}/storage" class="storage-form">
    ${csrfField(csrf)}
    <div class="storage-field storage-provider">
      <label for="storage-provider">Provider</label>
      <select id="storage-provider" name="provider">
        ${Object.entries(providers).map(([k, name]) => html`<option value="${k}" ${v.provider === k ? html`selected` : ''}>${name}</option>`)}
      </select>
    </div>
    ${field('storage-account', 'Storage account', 'The account name, as the Azure portal shows it.', { value: v.account, placeholder: 'mystorageaccount', only: 'azure' })}
    <div class="storage-field">
      <label for="storage-bucket"><span data-only="s3 r2 gcs">Bucket</span><span data-only="azure">Container</span><span class="no-has">Bucket or container</span></label>
      <input id="storage-bucket" name="bucket" type="text" value="${v.bucket}" placeholder="${PLACEHOLDER.bucket}" autocomplete="off" spellcheck="false" required>
    </div>
    ${field('storage-region', 'Region', 'S3 only, e.g. eu-west-1.', { value: v.region, placeholder: 'us-east-1', only: 's3' })}
    <div class="storage-field">
      <label for="storage-endpoint"><span data-only="r2">Account endpoint</span><span data-only="s3 gcs azure">Endpoint</span><span class="no-has">Endpoint</span></label>
      <input id="storage-endpoint" name="endpoint" type="text" value="${v.endpoint}" placeholder="${PLACEHOLDER.endpoint}" autocomplete="off" spellcheck="false">
      ${per('r2', 'Required: https://<account_id>.r2.cloudflarestorage.com, from the R2 page in Cloudflare.')}
      ${per('s3', 'Optional, for an S3-compatible service. Empty: AWS for the region. https only.')}
      ${per('gcs', 'Optional. Empty: https://storage.googleapis.com.')}
      ${per('azure', 'Optional. Empty: https://<account>.blob.core.windows.net.')}
    </div>
    ${field('storage-prefix', 'Prefix', 'Optional. Everything goes under it.', { value: v.prefix, placeholder: PLACEHOLDER.prefix })}
    <fieldset class="storage-secrets">
      <legend>Credentials <span class="fine">Encrypted at rest, never shown again.</span></legend>
      ${field('storage-access-key-id', 'Access key ID', html`<span data-only="s3">An IAM access key.</span><span data-only="r2">An R2 API token's access key ID.</span><span data-only="gcs">A GCS HMAC key of a service account.</span>`, { type: 'password', only: 's3 r2 gcs' })}
      ${field('storage-secret-access-key', 'Secret access key', null, { type: 'password', only: 's3 r2 gcs' })}
      ${field('storage-account-key', 'Account key', 'Azure only: an access key of the storage account.', { type: 'password', only: 'azure' })}
    </fieldset>
    <p class="storage-actions"><button class="btn btn-primary" type="submit">Test and save</button>
      <span class="fine">Grapim writes, reads, lists and deletes a test object first. ${status.config ? 'The same bucket with new keys replaces the keys; another bucket starts a move.' : 'Then it copies the files the hub keeps for this team, and switches when the copy is complete.'}</span></p>
  </form>`;
}

export function storageSection({ team, csrf, status, providers, error = null, form: values = {} }) {
  const own = !!status.config;
  return html`<section class="card" id="storage" aria-labelledby="storage-title">
  <div class="card-head">
    <h2 id="storage-title" class="card-title">Workspace storage</h2>
    <span class="badge">${status.move ? 'moving' : own ? providers[status.provider] ?? status.provider : 'hub'}</span>
  </div>
  <p class="card-sub">Where workspace files and their versions are kept: the hub, or your own S3, R2, Google Cloud Storage or Azure bucket. <a href="https://github.com/twfly104/grapim/blob/main/docs/storage.md">The keys and policy to create</a></p>
  ${error ? html`<p class="notice notice-error" role="alert">${error}</p>` : ''}
  ${!status.available
    ? html`<p class="fine">Workspace storage is off on this hub, so there is nothing to keep elsewhere.</p>`
    : html`${own
      ? html`${where(status.config, providers)}
  <p class="fine">Credentials saved ${date(status.saved_at)}. ${status.credentials_ok ? 'They are encrypted and are not shown again.' : html`<strong class="warn-text">They cannot be read any more (the hub's secret changed). Enter them again below.</strong>`}</p>`
      : html`<p class="fine">In use: the hub's own storage.</p>`}
  ${status.move
    ? moveBlock({ team, csrf, status, providers })
    : html`<details class="howto" ${error ? html`open` : ''}>
    <summary>${own ? 'Replace the keys, or move to another bucket' : 'Use your own bucket'}</summary>
    ${form({ team, csrf, status, providers, values: error ? values : own ? { ...status.config, region: status.config.region ?? '', account: status.config.account ?? '' } : {} })}
  </details>
  ${own
    ? html`<form method="post" action="/hub/teams/${team.id}/storage/hub" class="storage-actions" data-confirm="Move this team's files back to the hub's storage? They are copied first; the copy in your bucket is not deleted.">${csrfField(csrf)}<button class="btn btn-sm" type="submit">Move back to the hub's storage</button></form>`
    : ''}`}`}
</section>`;
}
