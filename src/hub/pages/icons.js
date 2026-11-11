// The hub's functional icons: 16 px, one stroke weight, the same drawing as
// the review desk's (ui/views/shared.js), so the two read as one product.
// Never decoration: each one sits next to the text it stands for.

import { raw } from './html.js';

const S = 'fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"';

const P = {
  home: `<path d="M2.5 7.2 8 2.8l5.5 4.4V13a.5.5 0 0 1-.5.5H9.5V10h-3v3.5H3a.5.5 0 0 1-.5-.5Z" ${S}/>`,
  review: `<path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2Z" ${S}/><path d="m5.6 7 1.6 1.5 3.2-3" ${S}/>`,
  repo: `<path d="M3.5 3a1 1 0 0 1 1-1h8v10h-8a1 1 0 0 0-1 1Zm0 10a1 1 0 0 0 1 1h8v-2" ${S}/><path d="M6 5h4" ${S}/>`,
  workspace: `<path d="M2.5 4.5v7a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H8L6.5 3.5h-3a1 1 0 0 0-1 1Z" ${S}/>`,
  reports: `<path d="M2.5 13.5h11M4.5 11V8M8 11V4.5M11.5 11V6.5" ${S}/>`,
  settings: `<circle cx="8" cy="8" r="2" ${S}/><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1" ${S}/>`,
  search: `<circle cx="7" cy="7" r="4.5" ${S}/><path d="m10.5 10.5 3 3" ${S}/>`,
  chev: `<path d="m4.5 6 3.5 3.5L11.5 6" ${S}/>`,
  updown: `<path d="m5 6 3-3 3 3M5 10l3 3 3-3" ${S}/>`,
  right: `<path d="m6 4 4 4-4 4" ${S}/>`,
  check: `<path d="m3.5 8.5 3 3 6-7" ${S}/>`,
  x: `<path d="m4.5 4.5 7 7m0-7-7 7" ${S}/>`,
  copy: `<rect x="5.5" y="5.5" width="8" height="8" rx="1" ${S}/><path d="M10.5 3.5V3a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h.5" ${S}/>`,
  menu: `<path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" ${S}/>`,
  file: `<path d="M4 2.5h5l3 3v8H4z" ${S}/><path d="M9 2.5v3h3" ${S}/>`,
  pr: `<circle cx="4.5" cy="3.5" r="1.5" ${S}/><circle cx="4.5" cy="12.5" r="1.5" ${S}/><circle cx="11.5" cy="12.5" r="1.5" ${S}/><path d="M4.5 5v6M11.5 11V6.5a2 2 0 0 0-2-2H7.5m1.5-1.5L7.5 4.5 9 6" ${S}/>`,
  external: `<path d="M9.5 2.5h4v4M13.5 2.5 8 8M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" ${S}/>`,
  plus: `<path d="M8 3.5v9M3.5 8h9" ${S}/>`,
  out: `<path d="M6.5 13.5h-3a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3M10.5 11 13.5 8l-3-3M13.5 8H6.5" ${S}/>`,
};

export const icon = (name, cls = '') => raw(`<svg class="icon${cls ? ` ${cls}` : ''}" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">${P[name] ?? ''}</svg>`);

// The product mark: the same diamond on the hub, the desk and the favicon.
export const LOGO = raw('<svg class="logo" viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false"><path d="M10 1.5 18.5 10 10 18.5 1.5 10Z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 6 14 10 10 14 6 10Z" fill="currentColor"/></svg>');
