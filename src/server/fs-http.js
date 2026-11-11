// /fs/*: the agent workspace over plain HTTP.
//
//   GET    /fs/<path>     the file's bytes; a path ending in / lists the folder
//   PUT    /fs/<path>     write the body as the file (claimed, recorded)
//   DELETE /fs/<path>     delete the file (claimed, recorded)
//   POST   /fs/_release   release everything the agent holds
//
// Writes need X-Grapim-Agent; X-Grapim-Intent is optional.
// A GET of a file and a PUT answer with ETag: "<sha1 of the content>". PUT and
// DELETE take If-Match: "<sha1>" (the file must be that version) or
// If-Match: "absent" (there must be no file); otherwise 412 and nothing is written.

import { sha1 } from '../ledger.js';
import { httpAgent } from './fs.js';
import { badRequest, headerText, notAllowed, readBody, sendBytes, sendJson } from './http.js';
import { decodePath } from './paths.js';

const agentOf = (req) => httpAgent(headerText(req, 'x-grapim-agent'));
const etag = (sha) => `"${sha}"`;

// If-Match as an expectation: a sha, null for "absent", undefined for none.
function expectOf(req) {
  const raw = headerText(req, 'if-match');
  if (raw === null || raw === '') return undefined;
  const v = /^"([^"]*)"$/.exec(raw)?.[1] ?? raw;
  if (v === 'absent') return null;
  if (/^[0-9a-f]{40}$/.test(v)) return v;
  throw badRequest('If-Match must be "<sha1 of the current content>" (the ETag from GET) or "absent".');
}

// rawPath is "/fs" or starts with "/fs/".
export async function handleFs({ workspace }, req, res, rawPath) {
  const rel = decodePath(rawPath.slice('/fs/'.length));
  switch (req.method) {
    case 'GET':
    case 'HEAD': {
      if (rel === '' || rel.endsWith('/')) return sendJson(res, 200, workspace.list(rel));
      const { buf } = workspace.read(rel);
      return sendBytes(res, buf, undefined, { ETag: etag(sha1(buf)) });
    }
    case 'PUT': {
      const me = agentOf(req);
      const expect = expectOf(req);
      const body = await readBody(req);
      // A hub workspace answers with a promise (its line counts are computed
      // off the event loop first); grapim serve with the result.
      const r = await workspace.write(me, rel, body, { intent: headerText(req, 'x-grapim-intent'), expect });
      return sendJson(res, 200, r, { ETag: etag(r.sha) });
    }
    case 'DELETE': {
      const me = agentOf(req);
      return sendJson(res, 200, await workspace.remove(me, rel, { intent: headerText(req, 'x-grapim-intent'), expect: expectOf(req) }));
    }
    case 'POST':
      if (rel === '_release') return sendJson(res, 200, await workspace.release(agentOf(req)));
      throw notAllowed(['GET', 'PUT', 'DELETE']);
    default:
      throw notAllowed(['GET', 'PUT', 'DELETE', 'POST']);
  }
}
