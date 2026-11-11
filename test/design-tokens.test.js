// The review desk and the hub share one set of design tokens (ui/tokens.css),
// so they cannot drift: neither stylesheet redefines a shared token, and every
// custom property either uses is defined somewhere it loads.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const defined = (css) => new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]));
const used = (css) => new Set([...css.matchAll(/var\((--[a-z0-9-]+)/gi)].map((m) => m[1]));

test('the desk and the hub use one token file, and every token they use is defined', () => {
  const tokens = read('ui/tokens.css');
  const desk = read('ui/styles.css');
  const hub = read('src/hub/pages/hub.css');
  const shared = defined(tokens);
  for (const t of ['--bg', '--surface', '--text', '--accent', '--focus', '--radius', '--radius-lg', '--shadow-1', '--font', '--mono', '--dur', '--ease-out']) assert.ok(shared.has(t), `tokens.css defines ${t}`);
  assert.match(desk, /@import url\("tokens\.css"\)/);
  const layout = fs.readFileSync(path.join(ROOT, 'src/hub/pages/layout.js'), 'utf8');
  assert.ok(layout.indexOf('/hub/static/tokens.css') < layout.indexOf('/hub/static/hub.css'), 'the hub loads the tokens before its own styles');
  for (const [name, css] of [['ui/styles.css', desk], ['src/hub/pages/hub.css', hub]]) {
    const own = defined(css);
    const redefined = [...own].filter((t) => shared.has(t));
    assert.deepEqual(redefined, [], `${name} redefines shared tokens`);
    const missing = [...used(css)].filter((t) => !shared.has(t) && !own.has(t) && !['--c', '--vis-top', '--vis-h'].includes(t));
    assert.deepEqual(missing, [], `${name} uses undefined tokens`);
  }
});
