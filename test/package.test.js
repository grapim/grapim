// What `npm publish` would put in the grapim tarball: what the CLI needs to
// run, and nothing private (tests, research, outreach, the hub's source,
// screenshots, local settings, secrets).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function packFiles() {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    windowsHide: true,
    timeout: 120_000,
  });
  const [pack] = JSON.parse(out.slice(out.indexOf('[')));
  return pack;
}

test('the npm package holds what the CLI needs and nothing private', () => {
  const pack = packFiles();
  const files = pack.files.map((f) => f.path.split('\\').join('/'));

  for (const need of ['package.json', 'README.md', 'LICENSE', 'bin/grapim.js', 'src/cli.js', 'src/hook.js', 'src/agents.js', 'src/mcp.js', 'src/sync.js', 'src/provenance/note.js', 'src/server/index.js', 'ui/index.html', 'hooks/hooks.json', '.claude-plugin/plugin.json', 'skills/grapim/SKILL.md', 'docs/cli.md']) {
    assert.ok(files.includes(need), `${need} is in the package`);
  }
  const banned = [
    /^test\//,
    /^sdk\//,
    /^research\//,
    /^outreach\//,
    /^launch\//,
    /^scripts\//,
    /^action\//,
    /^experiments\//,
    /^src\/hub\//,
    /^ui\/screenshots\//,
    /^ui\/fixtures\//,
    /^docs\/(screens|security|deploy|billing|platform)/,
    /(^|\/)\.claude\//,
    /(^|\/)\.env/,
    /(^|\/)\.grapim/,
    /\.(png|jpe?g|webp|gif|mp4|mov|log|tgz|pem|key|db|sqlite)$/i,
    /^(PLAN\.md|Dockerfile|railway\.json|server\.json)$/,
  ];
  const leaks = files.filter((f) => banned.some((re) => re.test(f)));
  assert.deepEqual(leaks, [], 'files that must not be published');

  // Every file the package's own code imports is in the package (except the hub, run from source).
  for (const f of files.filter((x) => /\.(m?js)$/.test(x) && (x.startsWith('src/') || x.startsWith('bin/')))) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of text.matchAll(/(?:from\s+|import\()\s*'(\.{1,2}\/[^']+)'/g)) {
      const dep = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1]));
      if (dep.startsWith('src/hub/')) continue;
      assert.ok(files.includes(dep), `${f} imports ${m[1]}, which is not in the package`);
    }
  }
  assert.ok(pack.size < 1_000_000, `packed size ${pack.size} bytes`);
  assert.ok(fs.readFileSync(path.join(ROOT, 'bin', 'grapim.js'), 'utf8').startsWith('#!/usr/bin/env node\n'));
});

test('package.json is ready to publish', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'grapim');
  assert.match(pkg.version, /^\d+\.\d+\.\d+(-[\w.]+)?$/);
  assert.equal(pkg.license, 'Apache-2.0');
  assert.match(fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8'), /Apache License\s+Version 2\.0, January 2004/);
  assert.equal(pkg.engines.node, '>=22.13');
  assert.equal(pkg.bin.grapim, 'bin/grapim.js');
  assert.equal(pkg.dependencies, undefined, 'zero runtime dependencies');
  assert.equal(pkg.publishConfig.access, 'public');
  assert.equal(pkg.publishConfig.provenance, undefined, 'set by the release workflow: a laptop publish would fail with it');
  // The version is the same everywhere it is written down.
  const plugin = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  const server = JSON.parse(fs.readFileSync(path.join(ROOT, 'server.json'), 'utf8'));
  const mcp = fs.readFileSync(path.join(ROOT, 'src', 'mcp.js'), 'utf8').match(/export const VERSION = '([^']+)'/)[1];
  assert.deepEqual([plugin.version, server.version, server.packages[0].version, mcp], Array(4).fill(pkg.version));
});
