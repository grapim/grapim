// Escaped-by-default HTML templates. Every interpolated value is escaped
// unless it is the output of another html`` template (a Raw).

class Raw {
  constructor(s) {
    this.s = s;
  }
  toString() {
    return this.s;
  }
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"'`]/g, (c) => ESC[c]);

const part = (v) => {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(part).join('');
  return esc(v);
};

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += part(values[i]) + strings[i + 1];
  return new Raw(out);
}

export const raw = (s) => new Raw(s);

export function ago(ms, now = Date.now()) {
  if (!valid(ms)) return 'never';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ms).toISOString().slice(0, 10);
}

// Synced timestamps are input: one a Date cannot hold must not break a page.
const valid = (ms) => Number.isFinite(ms) && ms > 0 && Math.abs(ms) <= 8.64e15;

export const time = (ms, now) => (valid(ms) ? html`<time datetime="${new Date(ms).toISOString()}" title="${new Date(ms).toISOString().replace('T', ' ').slice(0, 16)} UTC">${ago(ms, now)}</time>` : html`<span class="muted">never</span>`);

export const date = (ms) => (valid(ms) ? new Date(ms).toISOString().slice(0, 10) : '');
