// SaaS connectors: an external system mapped onto workspace files under
// saas/<connector>/, so an agent's change to SaaS data is recorded, reviewed
// and undone like a change to a file (docs/connectors.md).
//
// A connector is an object:
//   describe() -> { name, title, root: 'saas/<name>/', scope, run }
//   test() -> { name, workspace }                 checks the credentials
//   list() -> [{ id, title, edited, path }]        everything in scope
//   pull(since) -> { items: [{ id, path, longPath?, title, content, version,
//                    edited }], present: Set(id) | null, cursor }
//     items changed since the cursor (all without one), each with the file
//     it proposes and its content as text; present lists every id in scope
//     (null if unknown), so items that left it are removed.
//   push(entry, content, baseVersion) -> { version, remote, ops }
//                                      | { conflict: true, version, remote }
//     writes content remotely only if the item is still at baseVersion;
//     remote is the item as now rendered remotely.
//   remove(entry), restore(entry)                  the file was deleted / came back
//
// createSync (sync.js) does the rest the same way for every connector: the
// mapping state, the ledger, merges and conflict copies, path checks.

import { createNotionConnector } from './notion/index.js';

export { connectorPath, checkPath, createSync, PathRefused, SAAS_ROOT } from './sync.js';
export { createQueue } from './queue.js';

// name -> { title, create(options) }. The hub offers each in a workspace's page.
export const CONNECTORS = Object.freeze({
  notion: { title: 'Notion', create: createNotionConnector },
});
