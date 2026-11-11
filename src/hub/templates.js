// Folder templates for a new cloud workspace (docs/workspaces.md, "Folder
// templates"): a few folders, each with a short README.md, so agents scoped
// to a folder (src/scope.js) have somewhere to start.
//
// The files are written as one recorded run, template:<name>, so they show in
// the ledger, blame and history like any other change, and can be undone. It
// is approved on creation, like undo and restore runs: nobody needs to review
// a template.

import path from 'node:path';
import { countLines, snapshot } from '../ledger.js';
import { autoApprove } from '../review.js';
import { atomicWrite } from '../server/fs.js';
import { fileKey, rootKey } from '../workspace.js';
import { HttpError } from './http.js';

const readme = (title, lines) => `# ${title}\n\n${lines.join('\n')}\n`;

export const TEMPLATES = Object.freeze({
  blank: [],
  'agent-team': [
    ['code/README.md', readme('code', ['Source code the agents write and change: apps, scripts, tests.', '', 'Give a coding agent a token limited to `code/**` (write) so it cannot touch the rest.'])],
    ['docs/README.md', readme('docs', ['Specs, plans, decisions and handover notes, in Markdown.', '', 'Agents that write code usually read this folder; a writing agent gets `docs/**` (write).'])],
    ['data/README.md', readme('data', ['Inputs and outputs: CSV, JSON, exports and generated reports.', '', 'Keep raw inputs and the files agents produce in separate subfolders.'])],
    ['saas/README.md', readme('saas', ['Content synced from the SaaS tools the team uses (one folder per tool), and their settings.', '', 'Agents usually only read it: give them `saas/**` (read).'])],
  ],
  research: [
    ['sources/README.md', readme('sources', ['Papers, articles, transcripts and links the research is based on.', '', 'Add files as they are; do not edit them afterwards.'])],
    ['notes/README.md', readme('notes', ['Notes on the sources: summaries, quotes, open questions.', '', 'One file per source or topic.'])],
    ['drafts/README.md', readme('drafts', ['Drafts of what the research produces: reports, posts, briefs.', '', 'A writing agent gets `drafts/**` (write) and `sources/**`, `notes/**` (read).'])],
  ],
  data: [
    ['raw/README.md', readme('raw', ['Data exactly as it arrived: exports, dumps, API responses.', '', 'Never edited in place, so every result can be traced back to it.'])],
    ['clean/README.md', readme('clean', ['Cleaned and joined data, made from raw/ by scripts or agents.', '', 'Say in each file or a note next to it which raw files it came from.'])],
    ['reports/README.md', readme('reports', ['Tables, charts and write-ups made from clean/.', '', 'A reporting agent gets `clean/**` (read) and `reports/**` (write).'])],
  ],
});

export const TEMPLATE_NAMES = Object.freeze(Object.keys(TEMPLATES));

// The template name as given (absent: blank), or a 400.
export function cleanTemplate(raw) {
  if (raw === undefined || raw === null || raw === '') return 'blank';
  if (typeof raw === 'string' && Object.hasOwn(TEMPLATES, raw)) return raw;
  throw new HttpError(400, 'bad_request', `template must be one of ${TEMPLATE_NAMES.join(', ')}.`);
}

// Writes the template's files into the workspace an engine serves, as the
// run template:<name>, approved by `by`. Returns { run, files } (run null for blank).
export function applyTemplate(engine, name, by) {
  const files = TEMPLATES[cleanTemplate(name)];
  if (!files.length) return { run: null, files: [] };
  const { store, ws } = engine;
  const run = `template:${name}`;
  const written = [];
  for (const [rel, text] of files) {
    const abs = path.join(ws.root, ...rel.split('/'));
    const before = snapshot(abs);
    if (before.sha !== null) continue; // never over a file that is there
    atomicWrite(abs, Buffer.from(text, 'utf8'));
    const after = snapshot(abs);
    const f = fileKey(ws, abs);
    store.recordChange({ root: ws.root, root_key: rootKey(ws.root), path_key: f.key, path: f.display, run, label: run, turn: 0, untracked: false, ...countLines(store, before.buf, after.buf) }, before, after);
    written.push(f.display);
  }
  if (!written.length) return { run: null, files: [] };
  store.recordEvent(run, 'template', null, `${name}: ${written.join(', ')}`, by);
  autoApprove(store, run, by);
  return { run, files: written };
}
