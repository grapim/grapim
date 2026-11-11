// Notion pages <-> Markdown files, both ways.
//
// A page file is YAML front matter (the page's properties) and a body of
// Markdown in a small, fixed dialect, so that converting a page to Markdown
// and back gives the same blocks, and Markdown to blocks and back gives the
// same text (docs/connectors.md, "Round trips"):
//
//   # / ## / ###          heading_1, heading_2, heading_3
//   text                  paragraph (lines that follow are soft line breaks)
//   <br>                  an empty paragraph
//   - text                bulleted_list_item
//   1. text               numbered_list_item
//   - [ ] / - [x] text    to_do
//   ```lang ... ```       code (a bare fence is "plain text")
//   > text                quote
//   > [!callout] 💡       callout, with its text on the following "> " lines
//   ---                   divider
//   ```notion-block       any other block, kept as JSON so a round trip never
//   {...}                 loses it (images, tables, toggles, embeds, child
//   ```                   pages, synced blocks, ...)
//
// Inline: **bold**, *italic* (or _italic_), ~~strike~~, `code`, [text](url),
// and \ before any punctuation for a literal character.
// Children of a block (nested list items, or blocks under a paragraph, quote
// or callout) are indented under it: by the list marker's width for list
// items, 2 spaces otherwise, after a blank line unless the first child is a
// list item.
//
// Everything here is pure: no I/O, no Notion ids are invented.

export const SUPPORTED = new Set([
  'paragraph',
  'heading_1',
  'heading_2',
  'heading_3',
  'bulleted_list_item',
  'numbered_list_item',
  'to_do',
  'code',
  'quote',
  'callout',
  'divider',
]);

// Block types whose children this dialect shows. Headings with children
// (toggle headings) are kept whole as notion-block JSON instead.
export const CHILD_TYPES = new Set(['paragraph', 'bulleted_list_item', 'numbered_list_item', 'to_do', 'quote', 'callout']);
const LIST_TYPES = new Set(['bulleted_list_item', 'numbered_list_item', 'to_do']);

const BREAK = '<br>';
const OPAQUE_FENCE = 'notion-block';
const MAX_TEXT = 2000; // Notion's limit per rich text item
const MAX_INLINE_STEPS = 500_000; // characters scanned while trying emphasis, per text

// ---------------------------------------------------------------------------
// Rich text
// ---------------------------------------------------------------------------

const ANN = ['bold', 'italic', 'strike', 'code'];
const keyOf = (s) => `${s.bold ? 1 : 0}${s.italic ? 1 : 0}${s.strike ? 1 : 0}${s.code ? 1 : 0}|${s.link ?? ''}`;

// Notion rich text items -> [{ text, bold, italic, strike, code, link }],
// adjacent runs with the same marks merged. Mentions and equations become
// their plain text (a mention with a link keeps it).
export function segmentsOf(rich) {
  const out = [];
  for (const r of Array.isArray(rich) ? rich : []) {
    if (!r || typeof r !== 'object') continue;
    const a = r.annotations ?? {};
    const text = r.type === 'text' ? String(r.text?.content ?? r.plain_text ?? '') : String(r.plain_text ?? '');
    const link = r.type === 'text' ? r.text?.link?.url ?? null : r.href ?? null;
    if (!text) continue;
    out.push({ text, bold: !!a.bold, italic: !!a.italic, strike: !!a.strikethrough, code: !!a.code, link: link ? String(link) : null });
  }
  return merge(out);
}

function merge(segs) {
  const out = [];
  for (const s of segs) {
    if (!s.text) continue;
    const last = out.at(-1);
    if (last && keyOf(last) === keyOf(s)) last.text += s.text;
    else out.push({ ...s });
  }
  return out;
}

// Segments -> Notion rich text items (2000 characters at most each).
export function richOf(segs) {
  const out = [];
  for (const s of merge(segs)) {
    for (let i = 0; i < s.text.length; i += MAX_TEXT) {
      out.push({
        type: 'text',
        text: { content: s.text.slice(i, i + MAX_TEXT), link: s.link ? { url: s.link } : null },
        annotations: { bold: !!s.bold, italic: !!s.italic, strikethrough: !!s.strike, underline: false, code: !!s.code, color: 'default' },
      });
    }
  }
  return out;
}

export const plainOf = (rich) => segmentsOf(rich).map((s) => s.text).join('');

const PUNCT = /[!-/:-@[-`{-~]/;
const isAlnum = (c) => !!c && /[\p{L}\p{N}]/u.test(c);
const isSpace = (c) => c === undefined || /\s/.test(c);

// Literal text -> Markdown that parses back to exactly this text.
function escapeText(t) {
  let out = t.replace(/[\\`*[\]]/g, '\\$&').replace(/~~/g, '\\~\\~');
  // _ only starts or ends emphasis at a word boundary.
  out = out.replace(/_/g, (m, i, s) => (isAlnum(s[i - 1]) && isAlnum(s[i + 1]) ? '_' : '\\_'));
  return out;
}

function codeSpan(t) {
  // The shortest fence no run of backticks inside has the length of.
  const runs = new Set((t.match(/`+/g) ?? []).map((r) => r.length));
  let n = 1;
  while (runs.has(n)) n++;
  const fence = '`'.repeat(n);
  const pad = t.startsWith('`') || t.endsWith('`') || (t.startsWith(' ') && t.endsWith(' ') && t.trim()) ? ' ' : '';
  return `${fence}${pad}${t}${pad}${fence}`;
}

function linkTarget(url) {
  return /[\s()<>]/.test(url) ? `<${url.replace(/[<>]/g, (c) => encodeURIComponent(c))}>` : url;
}

// Moves leading and trailing spaces outside emphasis markers (Markdown does
// not allow ** foo **).
function renderSeg(s) {
  if (!s.code && !s.bold && !s.italic && !s.strike) return escapeText(s.text);
  if (s.code) {
    let body = codeSpan(s.text);
    if (s.italic) body = `*${body}*`;
    if (s.bold) body = `**${body}**`;
    if (s.strike) body = `~~${body}~~`;
    return body;
  }
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s.text);
  if (!m[2]) return escapeText(s.text);
  let body = escapeText(m[2]);
  if (s.italic) body = `*${body}*`;
  if (s.bold) body = `**${body}**`;
  if (s.strike) body = `~~${body}~~`;
  return `${escapeText(m[1])}${body}${escapeText(m[3])}`;
}

// Segments -> inline Markdown.
export function inlineOf(segs) {
  let out = '';
  for (let i = 0; i < segs.length; ) {
    const link = segs[i].link;
    if (!link) {
      out += renderSeg(segs[i]);
      i++;
      continue;
    }
    let inner = '';
    while (i < segs.length && segs[i].link === link) inner += renderSeg(segs[i++]);
    out += `[${inner}](${linkTarget(link)})`;
  }
  return out;
}

export const richToMd = (rich) => inlineOf(segmentsOf(rich));

// Inline Markdown -> segments.
export function parseInline(src) {
  const budget = { steps: 0 };
  const out = [];
  seq(String(src), 0, {}, null, out, budget);
  return merge(out);
}

function closesAt(s, i, closer) {
  if (!s.startsWith(closer, i) || isSpace(s[i - 1])) return false;
  if (closer === '_' && isAlnum(s[i + 1])) return false;
  return true;
}

// Parses from i with marks `ann` until `closer` (or the end when closer is
// null). Returns the index after the closer, or -1 when it never closes.
// Emphasis needs some text inside (four stars are four stars), and every
// character scanned in an attempt counts against the budget: past it,
// nothing more is tried as emphasis, so hostile input stays literal.
function seq(s, i, ann, closer, out, budget) {
  let buf = '';
  let content = false; // any text inside yet
  const flush = () => {
    if (buf) out.push({ text: buf, bold: !!ann.bold, italic: !!ann.italic, strike: !!ann.strike, code: false, link: ann.link ?? null });
    buf = '';
  };
  const attempt = (len, mark, close) => {
    if (budget.steps > MAX_INLINE_STEPS) return -1;
    const sub = [];
    const j = seq(s, i + len, { ...ann, [mark]: true }, close, sub, budget);
    if (j < 0) return -1;
    flush();
    out.push(...sub);
    content = true;
    return j;
  };
  while (i < s.length) {
    if (closer && ++budget.steps > MAX_INLINE_STEPS) return -1;
    if (closer && content && closesAt(s, i, closer)) {
      flush();
      return i + closer.length;
    }
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && PUNCT.test(s[i + 1])) {
      content = true;
      buf += s[i + 1];
      i += 2;
      continue;
    }
    if (c === '`') {
      let n = 1;
      while (s[i + n] === '`') n++;
      const fence = '`'.repeat(n);
      let j = i + n;
      let found = -1;
      while ((j = s.indexOf(fence, j)) >= 0) {
        if (s[j + n] !== '`' && s[j - 1] !== '`') {
          found = j;
          break;
        }
        while (s[j] === '`') j++;
      }
      if (found < 0) {
        buf += fence;
        i += n;
        continue;
      }
      let body = s.slice(i + n, found);
      if (body.length > 2 && body.startsWith(' ') && body.endsWith(' ') && body.trim()) body = body.slice(1, -1);
      flush();
      if (body) out.push({ text: body, bold: !!ann.bold, italic: !!ann.italic, strike: !!ann.strike, code: true, link: ann.link ?? null });
      content = true;
      i = found + n;
      continue;
    }
    if (c === '[' && !ann.link) {
      const l = parseLink(s, i);
      if (l) {
        flush();
        const sub = [];
        seq(l.text, 0, { ...ann, link: l.url }, null, sub, budget);
        out.push(...sub);
        content = true;
        i = l.end;
        continue;
      }
    }
    if (s.startsWith('**', i) && !ann.bold && !isSpace(s[i + 2])) {
      const j = attempt(2, 'bold', '**');
      if (j >= 0) {
        i = j;
        continue;
      }
    }
    if (s.startsWith('~~', i) && !ann.strike && !isSpace(s[i + 2])) {
      const j = attempt(2, 'strike', '~~');
      if (j >= 0) {
        i = j;
        continue;
      }
    }
    if (c === '*' && !ann.italic && !isSpace(s[i + 1])) {
      const j = attempt(1, 'italic', '*');
      if (j >= 0) {
        i = j;
        continue;
      }
    }
    if (c === '_' && !ann.italic && !isAlnum(s[i - 1]) && !isSpace(s[i + 1])) {
      const j = attempt(1, 'italic', '_');
      if (j >= 0) {
        i = j;
        continue;
      }
    }
    if (c !== '*' && c !== '_' && c !== '~') content = true;
    buf += c;
    i++;
  }
  if (closer) return -1;
  flush();
  return i;
}

// [text](url) or [text](<url>) at i, or null.
function parseLink(s, i) {
  let depth = 0;
  let j = i;
  for (; j < s.length; j++) {
    if (s[j] === '\\') {
      j++;
      continue;
    }
    if (s[j] === '[') depth++;
    else if (s[j] === ']' && --depth === 0) break;
  }
  if (j >= s.length || s[j + 1] !== '(') return null;
  const text = s.slice(i + 1, j);
  let k = j + 2;
  let url;
  if (s[k] === '<') {
    const e = s.indexOf('>', k);
    if (e < 0 || s[e + 1] !== ')') return null;
    url = s.slice(k + 1, e).replace(/%3C/gi, '<').replace(/%3E/gi, '>');
    k = e + 2;
  } else {
    const e = s.indexOf(')', k);
    if (e < 0) return null;
    url = s.slice(k, e);
    if (/\s/.test(url)) return null;
    k = e + 1;
  }
  if (!url) return null;
  return { text, url, end: k };
}

// ---------------------------------------------------------------------------
// Blocks -> Markdown
// ---------------------------------------------------------------------------

const textOf = (b) => b[b.type]?.rich_text ?? [];

// Lines that would start another block when they open a paragraph get a backslash.
const BLOCKISH = /^(#{1,6}(\s|$)|>|[-+*]\s|\d+[.)]\s|```|---\s*$|\*\*\*\s*$|<br>\s*$|\s)/;
function escapeLine(line) {
  if (!BLOCKISH.test(line) || /^\s/.test(line)) return line;
  // "1. x": a backslash before a digit is not an escape, so escape the dot.
  if (/^\d/.test(line)) return line.replace(/[.)]/, '\\$&');
  return `\\${line}`;
}

// A volatile or private field Notion adds that is not part of the content
// (signed file URLs expire within the hour; timestamps and authors change
// without any edit to the block itself).
const DROP = new Set(['object', 'created_time', 'last_edited_time', 'created_by', 'last_edited_by', 'parent', 'archived', 'in_trash', 'request_id']);

function stable(v) {
  if (Array.isArray(v)) return v.map(stable);
  if (!v || typeof v !== 'object') return v;
  const out = {};
  for (const k of Object.keys(v)) {
    if (DROP.has(k)) continue;
    // A Notion-hosted file: its URL is signed and changes on every read.
    if (k === 'url' && 'expiry_time' in v) continue;
    if (k === 'expiry_time') continue;
    out[k] = stable(v[k]);
  }
  return out;
}

// The JSON an unsupported block is kept as.
export function opaqueJson(b) {
  const keep = { id: b.id ?? undefined, type: b.type, has_children: b.has_children ? true : undefined, [b.type]: stable(b[b.type] ?? {}) };
  return JSON.stringify(keep);
}

export const isOpaque = (b) => b.opaque === true || !SUPPORTED.has(b.type) || (b.has_children && !CHILD_TYPES.has(b.type));

const CODE_ALIASES = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  sh: 'shell',
  zsh: 'shell',
  console: 'shell',
  rb: 'ruby',
  rs: 'rust',
  yml: 'yaml',
  md: 'markdown',
  cpp: 'c++',
  cs: 'c#',
  csharp: 'c#',
  kt: 'kotlin',
  ps1: 'powershell',
  text: 'plain text',
  txt: 'plain text',
  plaintext: 'plain text',
  dockerfile: 'docker',
  objc: 'objective-c',
};
export const CODE_LANGUAGES = new Set(
  'abap arduino bash basic c clojure coffeescript c++ c# css dart diff docker elixir elm erlang flow fortran f# gherkin glsl go graphql groovy haskell html java javascript json julia kotlin latex less lisp livescript lua makefile markdown markup matlab mermaid nix objective-c ocaml pascal perl php plain_text powershell prolog protobuf python r reason ruby rust sass scala scheme scss shell sql swift typescript vb.net verilog vhdl visual_basic webassembly xml yaml java/c/c++/c#'
    .split(' ')
    .map((l) => l.replace('_', ' ')),
);

export function codeLanguage(info) {
  const l = String(info ?? '').trim().toLowerCase();
  if (!l) return 'plain text';
  const a = CODE_ALIASES[l] ?? l;
  return CODE_LANGUAGES.has(a) ? a : 'plain text';
}

function fenceFor(text) {
  const runs = text.match(/^`{3,}/gm) ?? [];
  return '`'.repeat(Math.max(3, ...runs.map((r) => r.length + 1)));
}

const prefixLines = (lines, first, rest) => lines.map((l, i) => (i === 0 ? first : rest) + l);

// One block's own lines (no children), with the list marker if any.
function ownLines(b, number) {
  if (isOpaque(b)) return ['```' + OPAQUE_FENCE, opaqueJson(b), '```'];
  const md = () => richToMd(textOf(b));
  switch (b.type) {
    case 'paragraph': {
      const t = md();
      return t === '' ? [BREAK] : t.split('\n').map(escapeLine);
    }
    case 'heading_1':
    case 'heading_2':
    case 'heading_3': {
      const t = md().replace(/\n/g, ' ');
      const hashes = '#'.repeat(Number(b.type.at(-1)));
      return [t ? `${hashes} ${t}` : hashes];
    }
    case 'bulleted_list_item':
      return prefixLines(md().split('\n'), '- ', '  ');
    case 'numbered_list_item': {
      const marker = `${number}. `;
      return prefixLines(md().split('\n'), marker, ' '.repeat(marker.length));
    }
    case 'to_do':
      return prefixLines(md().split('\n'), b.to_do?.checked ? '- [x] ' : '- [ ] ', '  ');
    case 'code': {
      const text = plainOf(textOf(b));
      const lang = b.code?.language && b.code.language !== 'plain text' ? b.code.language : '';
      const fence = fenceFor(text);
      return [fence + lang, ...text.split('\n'), fence];
    }
    case 'quote':
      return md()
        .split('\n')
        .map((l) => (l ? `> ${l}` : '>'));
    case 'callout': {
      const icon = b.callout?.icon?.type === 'emoji' ? b.callout.icon.emoji : '';
      const t = md();
      return [`> [!callout]${icon ? ` ${icon}` : ''}`, ...(t === '' ? [] : t.split('\n').map((l) => (l ? `> ${l}` : '>')))];
    }
    case 'divider':
      return ['---'];
    default:
      return ['```' + OPAQUE_FENCE, opaqueJson(b), '```'];
  }
}

function childIndent(b, number) {
  if (b.type === 'numbered_list_item') return `${number}. `.length;
  return 2;
}

const listy = (b) => !isOpaque(b) && LIST_TYPES.has(b.type);
// Bullets and to-dos are one Markdown list; numbered items another.
const family = (b) => (b.type === 'numbered_list_item' ? 'n' : 'b');

// A block with its children, as lines.
function blockLines(b, number) {
  const lines = ownLines(b, number);
  const kids = !isOpaque(b) && CHILD_TYPES.has(b.type) && Array.isArray(b.children) ? b.children : [];
  if (!kids.length) return lines;
  const pad = ' '.repeat(childIndent(b, number));
  const inner = linesOf(kids).map((l) => (l ? pad + l : l));
  return [...lines, ...(listy(kids[0]) ? [] : ['']), ...inner];
}

// Blocks -> lines: list items of one list on consecutive lines, everything
// else separated by one blank line.
function linesOf(blocks) {
  const out = [];
  let number = 0;
  let prev = null;
  for (const b of blocks) {
    number = b.type === 'numbered_list_item' && !isOpaque(b) && prev?.type === 'numbered_list_item' && !isOpaque(prev) ? number + 1 : 1;
    if (prev) {
      const tight = listy(prev) && listy(b) && family(prev) === family(b) && !(prev.children?.length && !listy(prev.children[0]) && !isOpaque(prev));
      if (!tight) out.push('');
    }
    out.push(...blockLines(b, number));
    prev = b;
  }
  return out;
}

export const blocksToMd = (blocks) => linesOf(blocks).join('\n');

// One block (with its children) as Markdown: what the block diff compares.
export const blockMd = (b) => blockLines(b, 1).join('\n');
// Only the block's own content, without children.
export const ownMd = (b) => ownLines(b, 1).join('\n');

// ---------------------------------------------------------------------------
// Markdown -> blocks
// ---------------------------------------------------------------------------

const indentOf = (l) => /^ */.exec(l)[0].length;
const blank = (l) => l.trim() === '';

const make = (type, payload, children = []) => ({ type, [type]: payload, children });
const textBlock = (type, text, extra = {}) => make(type, { rich_text: richOf(parseInline(text)), ...extra });

function startOf(line) {
  let m;
  if ((m = /^(`{3,})(.*)$/.exec(line))) return { kind: 'fence', fence: m[1], info: m[2].trim() };
  if ((m = /^(#{1,6})(?:\s+(.*?))?\s*$/.exec(line))) return { kind: 'heading', level: Math.min(3, m[1].length), text: m[2] ?? '' };
  if (/^(---|\*\*\*|___)\s*$/.test(line)) return { kind: 'divider' };
  if (/^<br\s*\/?>\s*$/i.test(line)) return { kind: 'break' };
  if ((m = /^[-+*] \[( |x|X)\](?: (.*))?$/.exec(line))) return { kind: 'todo', checked: m[1] !== ' ', text: m[2] ?? '', width: 2 };
  if ((m = /^([-+*])(?: (.*))?$/.exec(line)) && (m[2] !== undefined || line.length === 1)) return { kind: 'bullet', text: m[2] ?? '', width: 2 };
  if ((m = /^(\d{1,9})[.)](?: (.*))?$/.exec(line))) return { kind: 'number', text: m[2] ?? '', width: m[1].length + 2 };
  if ((m = /^>\s?\[!callout\](?:\s+(.*?))?\s*$/i.exec(line))) return { kind: 'callout', icon: m[1] ?? '' };
  if (/^>/.test(line)) return { kind: 'quote' };
  return null;
}

// The lines indented under a block (children), starting at i: blank lines
// and lines indented at least `width`. Trailing blank lines are not taken.
function childRegion(lines, i, width) {
  let j = i;
  let last = i;
  while (j < lines.length && (blank(lines[j]) || indentOf(lines[j]) >= width)) {
    if (!blank(lines[j])) last = j + 1;
    j++;
  }
  const region = lines.slice(i, last).map((l) => (blank(l) ? '' : l.slice(width)));
  return { region, next: last };
}

const quoteText = (l) => l.replace(/^>\s?/, '');

// Parses lines into blocks.
function parseLines(lines) {
  const blocks = [];
  let i = 0;
  const withChildren = (b, width) => {
    if (!CHILD_TYPES.has(b.type)) return b;
    const { region, next } = childRegion(lines, i, width);
    if (region.some((l) => l !== '')) {
      b.children = parseLines(region);
      i = next;
    }
    return b;
  };
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) {
      i++;
      continue;
    }
    // An indented line no block above took: its text, without the indent.
    const s = indentOf(line) ? null : startOf(line);
    if (!s) {
      const text = [line.replace(/^ +/, '')];
      i++;
      while (i < lines.length && !blank(lines[i]) && (indentOf(lines[i]) > 0 || !startOf(lines[i]))) text.push(lines[i++]);
      blocks.push(withChildren(textBlock('paragraph', text.join('\n')), 2));
      continue;
    }
    switch (s.kind) {
      case 'fence': {
        const body = [];
        i++;
        while (i < lines.length && !(lines[i].startsWith(s.fence) && /^`+\s*$/.test(lines[i]) && lines[i].trim().length >= s.fence.length)) body.push(lines[i++]);
        i++; // the closing fence (or the end)
        if (s.info === OPAQUE_FENCE) {
          blocks.push(opaqueFrom(body.join('\n')));
          break;
        }
        const text = body.join('\n');
        blocks.push(make('code', { rich_text: richOf(text ? [{ text }] : []), language: codeLanguage(s.info) }));
        break;
      }
      case 'heading':
        i++;
        blocks.push(textBlock(`heading_${s.level}`, s.text));
        break;
      case 'divider':
        i++;
        blocks.push(make('divider', {}));
        break;
      case 'break':
        i++;
        blocks.push(withChildren(textBlock('paragraph', ''), 2));
        break;
      case 'todo':
      case 'bullet':
      case 'number': {
        const text = [s.text];
        i++;
        // Continuation lines: indented, directly below, not a block of their own.
        while (i < lines.length && !blank(lines[i]) && indentOf(lines[i]) >= s.width && !startOf(lines[i].slice(s.width))) text.push(lines[i++].slice(s.width));
        const type = s.kind === 'todo' ? 'to_do' : s.kind === 'bullet' ? 'bulleted_list_item' : 'numbered_list_item';
        blocks.push(withChildren(textBlock(type, text.join('\n'), s.kind === 'todo' ? { checked: s.checked } : {}), s.width));
        break;
      }
      case 'callout': {
        i++;
        const text = [];
        while (i < lines.length && /^>/.test(lines[i]) && !startOf(lines[i])?.icon && !/^>\s?\[!callout\]/i.test(lines[i])) text.push(quoteText(lines[i++]));
        const icon = s.icon ? { icon: { type: 'emoji', emoji: s.icon } } : {};
        blocks.push(withChildren(textBlock('callout', text.join('\n'), icon), 2));
        break;
      }
      case 'quote': {
        const text = [];
        while (i < lines.length && /^>/.test(lines[i]) && !/^>\s?\[!callout\]/i.test(lines[i])) text.push(quoteText(lines[i++]));
        blocks.push(withChildren(textBlock('quote', text.join('\n')), 2));
        break;
      }
      default:
        i++;
    }
  }
  return blocks;
}

// A notion-block fence back to its block. Bad JSON stays visible as a code
// block instead of being dropped.
function opaqueFrom(text) {
  try {
    const v = JSON.parse(text);
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.type === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(v.type)) {
      const b = { type: v.type, [v.type]: v[v.type] && typeof v[v.type] === 'object' ? v[v.type] : {}, opaque: true, children: [] };
      if (typeof v.id === 'string') b.id = v.id;
      if (v.has_children) b.has_children = true;
      return b;
    }
  } catch {}
  return make('code', { rich_text: richOf(text ? [{ text }] : []), language: 'json' });
}

export const mdToBlocks = (md) => parseLines(String(md).replace(/\r\n?/g, '\n').split('\n'));

// ---------------------------------------------------------------------------
// Front matter (page properties)
// ---------------------------------------------------------------------------

const PLAIN_KEY = /^[\p{L}\p{N}_][\p{L}\p{N}_ .()/-]*$/u;
const keyText = (k) => (PLAIN_KEY.test(k) && !/\s$/.test(k) ? k : JSON.stringify(k));

function valueText(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') {
    const plain = /^[\p{L}\p{N}][^\n:#]*$/u.test(v) && !/\s$/.test(v) && !/^(true|false|null|yes|no|on|off|~)$/i.test(v);
    let json = true;
    try {
      JSON.parse(v);
    } catch {
      json = false;
    }
    return plain && !json ? v : JSON.stringify(v);
  }
  return JSON.stringify(v);
}

// { name: value } -> front matter lines. `comment` is a read-only line.
export function frontMatter(props, comment = null) {
  const lines = ['---'];
  if (comment) lines.push(`# ${comment.replace(/\n/g, ' ')}`);
  for (const [k, v] of props) lines.push(`${keyText(k)}: ${valueText(v)}`);
  lines.push('---');
  return lines.join('\n');
}

function parseValue(raw) {
  const t = raw.trim();
  if (t === '' || t === '~') return null;
  if (/^["[{]/.test(t) || /^(true|false|null|-?\d+(\.\d+)?([eE][-+]?\d+)?)$/.test(t)) {
    try {
      return JSON.parse(t);
    } catch {}
  }
  if (/^'.*'$/.test(t)) return t.slice(1, -1).replace(/''/g, "'");
  return t;
}

// Markdown file -> { props: Map(name -> value) | null, body }.
export function splitFrontMatter(md) {
  const text = String(md).replace(/\r\n?/g, '\n');
  if (!text.startsWith('---\n')) return { props: null, body: text };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { props: null, body: text };
  const after = text.indexOf('\n', end + 4);
  const closing = text.slice(end + 1, after < 0 ? undefined : after);
  if (closing.trim() !== '---') return { props: null, body: text };
  const props = new Map();
  for (const line of text.slice(4, end).split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    let key;
    let rest;
    if (line.startsWith('"')) {
      const m = /^("(?:[^"\\]|\\.)*")\s*:(.*)$/.exec(line);
      if (!m) continue;
      try {
        key = JSON.parse(m[1]);
      } catch {
        continue;
      }
      rest = m[2];
    } else {
      const c = line.indexOf(':');
      if (c < 0) continue;
      key = line.slice(0, c).trim();
      rest = line.slice(c + 1);
    }
    props.set(key, parseValue(rest));
  }
  const body = after < 0 ? '' : text.slice(after + 1).replace(/^\n/, '');
  return { props, body };
}

// The whole file: front matter, a blank line, the body, a final newline.
export function pageFile(props, blocks, comment = null) {
  const body = blocksToMd(blocks);
  return `${frontMatter(props, comment)}\n${body ? `\n${body}\n` : ''}`;
}
