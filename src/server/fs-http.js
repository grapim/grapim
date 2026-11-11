// /fs/*: the agent workspace over plain HTTP.
//
//   GET    /fs/<path>     the file's bytes; a path ending in / lists the folder
//   PUT    /fs/<path>     write the body as the file (claimed, recorded)
//   DELETE /fs/<path>     delete the file (claimed, recorded)
//   POST   /fs/_release   release everything the agent holds
//
// Writes need X-Grapim-Agent; X-Grapim-Intent is optional.

import { httpAgent } from './fs.js';
import { headerText, notAllowed, readBody, sendBytes, sendJson } from './http.js';
import { decodePath } from './paths.js';

const agentOf = (req) => httpAgent(headerText(req, 'x-grapim-agent'));

// rawPath is "/fs" or starts with "/fs/".
export async function handleFs({ workspace }, req, res, rawPath) {
  const rel = decodePath(rawPath.slice('/fs/'.length));
  switch (req.method) {
    case 'GET':
    case 'HEAD':
      if (rel === '' || rel.endsWith('/')) return sendJson(res, 200, workspace.list(rel));
      return sendBytes(res, workspace.read(rel).buf);
    case 'PUT': {
      const me = agentOf(req);
      const body = await readBody(req);
      return sendJson(res, 200, workspace.write(me, rel, body, { intent: headerText(req, 'x-grapim-intent') }));
    }
    case 'DELETE': {
      const me = agentOf(req);
      return sendJson(res, 200, workspace.remove(me, rel, { intent: headerText(req, 'x-grapim-intent') }));
    }
    case 'POST':
      if (rel === '_release') return sendJson(res, 200, workspace.release(agentOf(req)));
      throw notAllowed(['GET', 'PUT', 'DELETE']);
    default:
      throw notAllowed(['GET', 'PUT', 'DELETE', 'POST']);
  }
}
