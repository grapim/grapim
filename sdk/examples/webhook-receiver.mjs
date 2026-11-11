// A webhook receiver on node:http that verifies Grapim-Signature before
// trusting anything in the body.
//
// Run:  GRAPIM_WEBHOOK_SECRET=whsec_... PORT=8787 node sdk/examples/webhook-receiver.mjs
// Then point an endpoint at it (POST /v1/webhook_endpoints wants https, so put
// a TLS proxy or tunnel in front for local testing).

import http from 'node:http';

// In your app: import { verifyWebhook, WebhookSignatureError } from '@grapim/sdk';
import { verifyWebhook, WebhookSignatureError } from '../js/src/index.js';

const secret = process.env.GRAPIM_WEBHOOK_SECRET;
if (!secret) {
  console.error('Set GRAPIM_WEBHOOK_SECRET to the endpoint secret (whsec_...).');
  process.exit(1);
}

const MAX_BODY = 1024 * 1024;
const seen = new Set(); // event ids already handled; use your database in production

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/grapim/webhooks') {
    res.writeHead(404).end();
    return;
  }

  // The raw bytes, exactly as sent: the signature covers them, not re-serialised JSON.
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) {
      res.writeHead(413).end();
      return;
    }
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks);

  let event;
  try {
    event = await verifyWebhook(raw, req.headers['grapim-signature'], secret, { tolerance: 300 });
  } catch (e) {
    if (e instanceof WebhookSignatureError) {
      console.warn(`refused a delivery: ${e.code}`);
      res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: e.code }));
      return;
    }
    throw e;
  }

  // Deliveries are retried, so the same event can arrive twice.
  if (!seen.has(event.id)) {
    seen.add(event.id);
    handle(event);
  }
  // Answer fast (delivery times out after 10 s); do slow work in a queue.
  res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"received":true}');
});

function handle(event) {
  const who = event.workspace?.external_id ?? event.workspace?.id;
  switch (event.type) {
    case 'run.started':
      console.log(`${who}: an agent run started (${event.data?.run ?? '?'})`);
      break;
    case 'edit.blocked':
      console.log(`${who}: two agents reached for the same file`);
      break;
    case 'run.undone':
      console.log(`${who}: a run was undone`);
      break;
    default:
      console.log(`${who}: ${event.type}`);
  }
}

server.listen(Number(process.env.PORT ?? 8787), '127.0.0.1', () => {
  console.log(`listening on http://127.0.0.1:${server.address().port}/grapim/webhooks`);
});
