// Embedded mode: the review desk inside a platform's own product, in an
// iframe. Off unless the page was opened with ?embed=1.
//
// What the hub injects into index.html for an embed session:
//   <meta name="grapim-embed-origin" content="https://app.example.com">
//     the one origin allowed to receive our events and send us commands.
//     Missing or not a bare origin: we send nothing and accept nothing.
//   <meta name="grapim-embed-mode" content="review|readonly">
//     readonly hides approve, reject, undo, restore and branch.
// /api/overview may also carry `embed: { mode, origin }`. Its mode can only
// make the desk stricter; an origin there that disagrees with the meta tag
// turns messaging off rather than picking one.
//
// URL: ?embed=1 &theme=light|dark|system &brand=0 (hide "Powered by Grapim").
//
// Events to the parent, each { type, ...fields }, posted to that origin only:
//   grapim:ready         { view, mode }
//   grapim:run-opened    { run, label }
//   grapim:run-reviewed  { run, status }        status: approved|rejected|pending
//   grapim:undone        { run, turn, files }   files: paths the undo changed
//   grapim:height        { px }                 the content height, for auto-resizing iframes
// From the parent (same origin, and only from window.parent):
//   grapim:navigate      { view: live|runs|files|run, run?, path?, filter? }
//
// Nothing here imports the rest of the desk, so any module can use it.

const q = new URLSearchParams(location.search);
export const EMBED = q.get('embed') === '1';
const THEMES = new Set(['light', 'dark', 'system']);
export const embedTheme = EMBED && THEMES.has(q.get('theme')) ? q.get('theme') : 'system';
export const showBrand = EMBED && q.get('brand') !== '0';

const meta = (name) => (document.querySelector(`meta[name="${name}"]`)?.getAttribute('content') || '').trim();

// "https://app.example.com" (a trailing slash is tolerated); anything with a
// path, a query, credentials or another scheme is refused.
function bareOrigin(s) {
  if (!s || typeof s !== 'string') return null;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) return null;
    return u.origin === s.replace(/\/$/, '') ? u.origin : null;
  } catch {
    return null;
  }
}

// Anything but an explicit "review" (or nothing at all) reads as readonly:
// a typo should hide buttons, not show ones the server will refuse.
const isReadonly = (m) => m !== undefined && m !== null && m !== '' && m !== 'review';

const state = {
  origin: EMBED ? bareOrigin(meta('grapim-embed-origin')) : null,
  conflict: false,
  readonly: isReadonly(meta('grapim-embed-mode')),
  ready: false,
  queue: [],
  lastHeight: 0,
};
const modeListeners = new Set();

if (EMBED && meta('grapim-embed-origin') && !state.origin) {
  console.warn('[grapim] grapim-embed-origin is not a bare origin like https://app.example.com; embed events are off.');
}
if (state.readonly) document.documentElement.classList.add('readonly');

export const readonly = () => state.readonly;
export const onModeChange = (fn) => (modeListeners.add(fn), () => modeListeners.delete(fn));

// The tolerant read of /api/overview's `embed` field. Returns true when the
// desk just became readonly, so the caller can redraw.
export function readOverview(o) {
  const e = o && typeof o === 'object' ? o.embed : null;
  if (!e || typeof e !== 'object') return false;
  if (EMBED && e.origin && state.origin && bareOrigin(e.origin) !== state.origin && !state.conflict) {
    state.conflict = true;
    console.warn('[grapim] The embed origin from the server and the page disagree; embed events are off.');
  }
  if (!state.readonly && isReadonly(e.mode)) {
    state.readonly = true;
    document.documentElement.classList.add('readonly');
    for (const fn of modeListeners) fn();
    return true;
  }
  return false;
}

// Keyboard focus only moves when the person is in the desk. A cross-origin
// iframe that calls focus() while the host page has it would steal the
// caret from whatever they were typing on the host.
export const mayFocus = () => !EMBED || document.hasFocus();

// ---------------------------------------------------------------- events out

const canPost = () => EMBED && state.origin && !state.conflict && window.parent !== window;

function send(msg) {
  try { window.parent.postMessage(msg, state.origin); } catch {}
}

// Until grapim:ready has gone out, events wait, so the parent always hears
// ready first (opening the desk straight on a run would otherwise say
// run-opened before ready).
export function emit(type, fields = {}) {
  if (!canPost()) return;
  const msg = { type, ...fields };
  if (!state.ready) state.queue.push(msg);
  else send(msg);
}

export function ready(fields) {
  if (!canPost() || state.ready) return;
  state.ready = true;
  send({ type: 'grapim:ready', mode: state.readonly ? 'readonly' : 'review', ...fields });
  for (const m of state.queue.splice(0)) send(m);
  postHeight(true);
}

// ---------------------------------------------------------------- height

function contentHeight() {
  return Math.ceil(document.body.getBoundingClientRect().height);
}
function postHeight(force = false) {
  const px = contentHeight();
  if (!px || (!force && px === state.lastHeight)) return;
  state.lastHeight = px;
  if (state.ready) send({ type: 'grapim:height', px });
}

// ---------------------------------------------------------------- where the person is looking

// With an auto-height iframe the desk's own viewport is as tall as its
// content, so a centred dialog or a bottom toast can land far outside what
// the host page shows. An IntersectionObserver in an iframe reports the part
// of the target the top-level page actually shows, so dialogs and toasts are
// placed inside that part (--vis-top, --vis-h).
function trackVisible() {
  if (!('IntersectionObserver' in window)) return;
  const root = document.documentElement;
  const steps = Array.from({ length: 201 }, (_, i) => i / 200);
  const io = new IntersectionObserver((entries) => {
    const e = entries.at(-1);
    const r = e.intersectionRect;
    if (e.isIntersecting && r.height > 0) {
      root.style.setProperty('--vis-top', `${Math.max(0, Math.round(r.top))}px`);
      root.style.setProperty('--vis-h', `${Math.round(r.height)}px`);
    } else {
      root.style.removeProperty('--vis-top');
      root.style.removeProperty('--vis-h');
    }
  }, { threshold: steps });
  io.observe(document.querySelector('.app') || document.body);
}

// ---------------------------------------------------------------- commands in

const VIEWS = new Set(['live', 'runs', 'files', 'run']);
const FILTERS = new Set(['pending', 'active', 'approved', 'rejected', 'all']);
const str = (v, max = 500) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);

// Turns a navigate message into a hash route, or null if it is not one we take.
function routeOf(d) {
  const run = str(d.run);
  const view = d.view === undefined && run ? 'run' : d.view;
  if (!VIEWS.has(view)) return null;
  if (view === 'run') return run ? { view, run } : null;
  if (view === 'files') {
    const path = str(d.path, 2000);
    return { view, path: path && !path.split('/').includes('..') ? path.replace(/^\/+/, '') : null };
  }
  if (view === 'runs') return { view, filter: FILTERS.has(d.filter) ? d.filter : null };
  return { view };
}

export function start({ navigate }) {
  if (!EMBED) return;
  document.documentElement.classList.toggle('no-brand', !showBrand);
  trackVisible();
  if (!canPost()) return;
  if ('ResizeObserver' in window) {
    let raf = 0;
    new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => postHeight());
    }).observe(document.body);
  }
  window.addEventListener('message', (ev) => {
    if (ev.origin !== state.origin || ev.source !== window.parent || state.conflict) return;
    const d = ev.data;
    if (!d || typeof d !== 'object' || d.type !== 'grapim:navigate') return;
    const r = routeOf(d);
    if (r) navigate(r);
  });
}
