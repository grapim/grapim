// The docs at /docs: Markdown pages in src/hub/docs/*.md, rendered on the
// server by the small renderer below (our own files, still escaped like any
// other text), in a left nav / page / "on this page" layout. Copy buttons and
// the nav filter live in /hub/static/site.js; without it the page still reads.
//
// To add a page: write src/hub/docs/<slug>.md (front matter: title,
// description) and add it to NAV. A line that is exactly {{name}} is replaced
// by a generated block (BLOCKS below), e.g. the CLI reference.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { esc, html, raw } from './html.js';
import { ICON, SIGN_IN, siteBar, siteFooter, siteHead } from './site.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = path.join(HERE, '..', 'docs');
const CLI_SOURCE = path.join(HERE, '..', '..', 'cli.js');

// The nav, in reading order. The first page is /docs itself.
export const NAV = [
  { group: 'Get started', pages: ['quickstart', 'review', 'concepts', 'compare'] },
  { group: 'Using Grapim', pages: ['reviews', 'github', 'history', 'rules', 'notifications', 'undo', 'reports', 'inventory', 'ask-grapim', 'workspaces'] },
  { group: 'Reference', pages: ['cli', 'security', 'data-handling', 'faq', 'support'] },
];
export const ORDER = NAV.flatMap((g) => g.pages);
export const docPath = (slug) => (slug === ORDER[0] ? '/docs' : `/docs/${slug}`);

// ---- Markdown ----

const slugify = (s) =>
  String(s)
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z0-9#]+;/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

// Inline: `code`, **bold**, [text](href). Escaped first; code spans are cut
// out before the other rules so their content stays literal.
function inline(text) {
  return String(text)
    .split(/(`[^`]+`)/)
    .map((part) => {
      if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) return `<code>${esc(part.slice(1, -1))}</code>`;
      let s = esc(part);
      s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, href) => {
        const h = href.replace(/&amp;/g, '&');
        if (!/^(\/|#|https:\/\/)/.test(h)) return label;
        const ext = h.startsWith('https://');
        return `<a class="link" href="${esc(h)}"${ext ? ' rel="noopener"' : ''}>${label}</a>`;
      });
      return s;
    })
    .join('');
}

function codeBlock(info, lines) {
  const [lang = '', ...rest] = info.trim().split(/\s+/);
  const title = rest.join(' ');
  const copy = !['text', 'output'].includes(lang);
  const body = lines
    .map((l) => (lang === 'sh' && /^\s*#/.test(l) ? `<span class="c">${esc(l)}</span>` : esc(l)))
    .join('\n');
  return `<div class="code${copy ? '' : ' code-out'}">${title || copy ? `<div class="code-head"><span>${esc(title || (lang === 'sh' ? 'Terminal' : lang))}</span>${copy ? '<button class="copy" type="button" data-copy hidden>Copy</button>' : ''}</div>` : ''}<pre><code>${body}</code></pre></div>`;
}

function table(rows) {
  const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const [head, , ...body] = rows;
  return `<div class="table-scroll"><table><thead><tr>${cells(head).map((c) => `<th scope="col">${inline(c)}</th>`).join('')}</tr></thead><tbody>${body
    .map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
    .join('')}</tbody></table></div>`;
}

// -> { html, toc: [{ id, text, level }] }
export function renderMarkdown(src, blocks = {}) {
  const lines = String(src).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  const toc = [];
  const ids = new Set();
  let i = 0;
  const isBlockStart = (l) => /^(#{2,3} |```|> |- |\d+\. |\||\{\{)/.test(l) || l.trim() === '---';
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) {
      i++;
      continue;
    }
    const h = /^(#{2,3}) (.+)$/.exec(l);
    if (h) {
      const level = h[1].length;
      let id = slugify(h[2]) || 'section';
      while (ids.has(id)) id += '-x';
      ids.add(id);
      const text = inline(h[2]);
      toc.push({ id, text, level });
      out.push(`<h${level} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true" tabindex="-1">#</a>${text}</h${level}>`);
      i++;
      continue;
    }
    const blk = /^\{\{([a-z-]+)\}\}$/.exec(l.trim());
    if (blk) {
      out.push(blocks[blk[1]] ? String(blocks[blk[1]]()) : '');
      i++;
      continue;
    }
    if (l.startsWith('```')) {
      const info = l.slice(3);
      const body = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++]);
      i++;
      out.push(codeBlock(info, body));
      continue;
    }
    if (l.trim() === '---') {
      out.push('<hr>');
      i++;
      continue;
    }
    if (l.startsWith('> ')) {
      const body = [];
      while (i < lines.length && lines[i].startsWith('>')) body.push(lines[i++].replace(/^> ?/, ''));
      out.push(`<aside class="callout">${body.join('\n').split(/\n\s*\n/).map((p) => `<p>${inline(p.replace(/\n/g, ' '))}</p>`).join('')}</aside>`);
      continue;
    }
    if (/^(- |\d+\. )/.test(l)) {
      const ordered = /^\d+\. /.test(l);
      const items = [];
      while (i < lines.length && (/^(- |\d+\. )/.test(lines[i]) || (/^ {2,}\S/.test(lines[i]) && items.length))) {
        if (/^ {2,}\S/.test(lines[i])) items[items.length - 1] += ` ${lines[i].trim()}`;
        else items.push(lines[i].replace(/^(- |\d+\. )/, ''));
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</${tag}>`);
      continue;
    }
    if (l.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
      out.push(table(rows));
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) para.push(lines[i++]);
    if (!para.length) para.push(lines[i++]);
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return { html: out.join('\n'), toc };
}

// ---- Pages ----

function parse(file) {
  const src = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n/.exec(src);
  const meta = {};
  if (m) for (const line of m[1].split('\n')) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: m ? src.slice(m[0].length) : src };
}

export function loadDocs(dir = DOCS_DIR) {
  const pages = new Map();
  for (const slug of ORDER) {
    const { meta, body } = parse(path.join(dir, `${slug}.md`));
    pages.set(slug, { slug, title: meta.title || slug, nav: meta.nav || meta.title || slug, description: meta.description || '', body });
  }
  return pages;
}

// ---- The CLI reference, from the CLI's own help text ----

// The HELP template literal in src/cli.js, so the reference cannot drift
// from `grapim help`. ${NAME} placeholders are filled from the file's own
// string constants (const NAME = '...'). null when it cannot be read.
export function cliHelp(source = CLI_SOURCE) {
  try {
    const src = fs.readFileSync(source, 'utf8').replace(/\r\n/g, '\n');
    const m = /const HELP = `([\s\S]*?)`;/.exec(src);
    if (!m) return null;
    const consts = new Map([...src.matchAll(/^(?:export )?const ([A-Z][A-Z0-9_]*) = '([^'\n]*)';$/gm)].map((x) => [x[1], x[2]]));
    const out = m[1].replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (all, k) => (consts.has(k) ? consts.get(k) : all));
    return out.includes('${') ? null : out;
  } catch {
    return null;
  }
}

// The help text as sections of entries.
// -> { sections: [{ title, entries: [{ usage, text }] }], notes: [text] }
// An entry with usage null is a note between entries ("(... take --json)").
export function parseHelp(help) {
  const lines = String(help).replace(/\r\n/g, '\n').split('\n');
  const sections = [];
  const notes = [];
  let sec = null;
  let last = null;
  const section = (title) => {
    sec = { title, entries: [] };
    sections.push(sec);
    last = null;
  };
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      last = null;
      continue;
    }
    const indent = line.length - line.trimStart().length;
    const t = line.trim();
    if (indent === 0) {
      if (/^usage:/i.test(t)) continue;
      if (/^\s+\S/.test(lines[i + 1] ?? '')) section(t.replace(/:$/, ''));
      else notes.push(t);
      continue;
    }
    if (!sec) section('Commands');
    if (indent <= 4 && /^\(.*\)$/.test(t)) {
      sec.entries.push({ usage: null, text: t.slice(1, -1) });
      last = null;
      continue;
    }
    if (indent <= 4) {
      // A command, an option, or "Env: NAME  text".
      const env = /^Env: (\S+)(?: {2,}(.*))?$/.exec(t);
      const m = env ?? /^(\S.*?)(?: {2,}(\S.*))?$/.exec(t);
      last = { usage: m[1], text: m[2] ?? '', env: !!env };
      sec.entries.push(last);
      continue;
    }
    // Deeper: another variable under "Env:", or the entry's text going on.
    const ev = /^([A-Z][A-Z0-9_]+(?:=\S+)?) {2,}(.*)$/.exec(t);
    if (ev && last?.env) {
      last = { usage: ev[1], text: ev[2], env: true };
      sec.entries.push(last);
    } else if (last) {
      last.text += `${last.text ? ' ' : ''}${t}`;
    }
  }
  return { sections, notes };
}

export const helpId = (title) => slugify(title) || 'commands';

function cliReference() {
  const help = cliHelp();
  if (!help) return html`<aside class="callout"><p>Run <code>grapim help</code> for the full list of commands in the version you have.</p></aside>`;
  const { sections, notes } = parseHelp(help);
  const row = (c) =>
    c.usage
      ? html`<div class="cli-row"><dt><code>${c.usage}</code></dt><dd>${c.text}</dd></div>`
      : html`<div class="cli-row cli-note"><dd>${c.text}</dd></div>`;
  return html`${sections.map((s) => html`<h2 id="${helpId(s.title)}"><a class="anchor" href="#${helpId(s.title)}" aria-hidden="true" tabindex="-1">#</a>${s.title}</h2>
<dl class="cli">${s.entries.map(row)}</dl>`)}
${notes.filter((n) => !/^(docs|issues):/i.test(n)).map((n) => html`<p>${n}</p>`)}`;
}

// The support page's first block: signed in, straight to the form.
function supportCta(signedIn) {
  return html`<div class="help-cta">
  ${signedIn
    ? html`<a class="btn btn-primary" href="/hub/support">Open Help and feedback</a>`
    : html`<a class="btn btn-primary" href="${SIGN_IN}?next=${encodeURIComponent('/hub/support')}" rel="nofollow">Sign in with GitHub to write to us</a>`}
  <p class="fine">${signedIn ? 'You are signed in: the form sends your message with your GitHub login.' : 'The form is inside the hub, so we know who to answer. Sign-in reads your public GitHub profile only.'}</p>
</div>`;
}

// ---- The page ----

function sideNav(pages, current, filter = false) {
  return html`<nav class="docs-nav" aria-label="${filter ? 'Docs' : 'Docs pages'}">
  ${filter ? html`<div class="docs-filter" hidden><label class="sr-only" for="docs-filter">Filter pages</label><input id="docs-filter" type="search" placeholder="Filter pages" autocomplete="off" spellcheck="false"></div>` : ''}
  ${NAV.map(
    (g) => html`<div class="docs-group"><h2>${g.group}</h2><ul>${g.pages.map((slug) => {
      const p = pages.get(slug);
      return html`<li><a href="${docPath(slug)}" data-words="${`${p.nav} ${p.title} ${p.description}`.toLowerCase()}" ${slug === current ? html`aria-current="page"` : ''}>${p.nav}</a></li>`;
    })}</ul></div>`,
  )}
  <p class="docs-none" hidden>No page matches.</p>
</nav>`;
}

export function docsPage({ pages, slug, origin, signedIn = false }) {
  const page = pages.get(slug);
  const idx = ORDER.indexOf(slug);
  const prev = idx > 0 ? pages.get(ORDER[idx - 1]) : null;
  const next = idx < ORDER.length - 1 ? pages.get(ORDER[idx + 1]) : null;
  const blocks = { cli: cliReference, 'support-cta': () => supportCta(signedIn) };
  const { html: body, toc } = renderMarkdown(page.body, blocks);
  // Generated blocks bring their own headings: list them too.
  if (slug === 'cli') {
    const help = cliHelp();
    if (help) for (const sec of parseHelp(help).sections) toc.push({ id: helpId(sec.title), text: esc(sec.title), level: 2 });
  }
  const group = NAV.find((g) => g.pages.includes(slug))?.group;
  const h2s = toc.filter((t) => t.level === 2);
  return html`${siteHead({ title: page.title, description: page.description, path: docPath(slug), origin })}
<body class="site docs">
<a class="skip" href="#main">Skip to content</a>
${siteBar({ current: 'docs', signedIn })}
<div class="docs-layout">
  <aside class="docs-side">
    <details class="docs-menu" data-docs-menu>
      <summary>${ICON.menu}<span>${group}</span><span class="docs-menu-cur">${page.nav}</span></summary>
      ${sideNav(pages, slug)}
    </details>
    <div class="docs-side-wide">${sideNav(pages, slug, true)}</div>
  </aside>
  <main id="main" class="docs-main">
    <article class="prose">
      <p class="docs-crumb"><a href="/docs">Docs</a><span aria-hidden="true">/</span><span>${group}</span></p>
      <h1>${page.title}</h1>
      ${page.description ? html`<p class="docs-lede">${page.description}</p>` : ''}
      ${raw(body)}
    </article>
    <nav class="pager" aria-label="Previous and next page">
      ${prev ? html`<a class="pager-prev" href="${docPath(prev.slug)}"><span>Previous</span><b>${prev.nav}</b></a>` : html`<span></span>`}
      ${next ? html`<a class="pager-next" href="${docPath(next.slug)}"><span>Next</span><b>${next.nav}</b></a>` : ''}
    </nav>
  </main>
  ${h2s.length > 1
    ? html`<nav class="docs-toc" aria-label="On this page"><h2>On this page</h2><ul>${h2s.map((t) => html`<li><a href="#${t.id}">${raw(t.text.replace(/<[^>]+>/g, ''))}</a></li>`)}</ul></nav>`
    : html`<div class="docs-toc" aria-hidden="true"></div>`}
</div>
${siteFooter()}
</body>
</html>`.toString();
}
