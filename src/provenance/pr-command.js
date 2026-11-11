// grapim provenance pr <base>..<head> [--json] [--max-files N]
//
// The same summary the GitHub Action and App post on a pull request, computed
// locally with git blame and the notes in refs/notes/grapim. Review statuses
// come from this repo's Grapim ledger when there is one (newer than the
// snapshot in the notes).

import fs from 'node:fs';
import path from 'node:path';
import { collectFromGit, GitError } from './pr.js';
import { renderEmpty, renderSummary } from './render.js';

const USAGE = 'Usage: grapim provenance pr <base>..<head> [--json] [--max-files 300]';

function localReviews(cwd) {
  return import('../workspace.js')
    .then(async ({ resolveWorkspace }) => {
      const { Store } = await import('../store.js');
      const { getReview } = await import('../review.js');
      const ws = resolveWorkspace(cwd);
      // Read only: never create a ledger in a repo that has none.
      if (!fs.existsSync(path.join(ws.stateDir, 'state.db'))) return null;
      const store = new Store(ws.stateDir);
      return {
        get: (run) => getReview(store, run)?.status ?? null,
        close: () => store.close(),
      };
    })
    .catch(() => null);
}

export async function prCommand(args, { cwd = process.cwd(), out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s) } = {}) {
  const json = args.includes('--json');
  const mf = args.indexOf('--max-files');
  const maxFiles = mf >= 0 ? Number(args[mf + 1]) : 300;
  const range = args.find((a, i) => !a.startsWith('--') && (mf < 0 || i !== mf + 1));
  const m = /^(.+?)\.\.\.?(.+)$/.exec(range ?? '');
  if (!m || !Number.isInteger(maxFiles) || maxFiles < 1) {
    err(`${USAGE}\n`);
    return 1;
  }
  let input;
  try {
    input = collectFromGit({ cwd, base: m[1], head: m[2], maxFiles });
  } catch (e) {
    err(`${e instanceof GitError ? e.message : `grapim provenance pr: ${e.message}`}\n`);
    return 1;
  }
  const reviews = {};
  const local = await localReviews(cwd);
  if (local) {
    try {
      const { attribute } = await import('./render.js');
      for (const r of attribute(input).runs) {
        const s = local.get(r.id);
        if (s) reviews[r.id] = s;
      }
    } catch {
    } finally {
      local.close();
    }
  }
  if (!input.hasNotes && !json) {
    out(renderEmpty({ via: 'action' }));
    return 0;
  }
  const { markdown, stats } = renderSummary({ ...input, reviews, limit: Infinity });
  out(json ? `${JSON.stringify({ base: input.base, head: input.head, merge_base: input.mergeBase, has_notes: input.hasNotes, ...stats }, null, 2)}\n` : markdown);
  return 0;
}
