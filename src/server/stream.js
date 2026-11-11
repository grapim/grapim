// GET /api/stream: server-sent events. One poller for all clients checks the
// events table every 500 ms (hooks write it from other processes, so polling
// SQLite is the only signal) and sends `event: tick` when it has grown.

import { busy } from './http.js';
import { lastEventId } from './queries.js';

// Each open stream is a socket held for good; a few browser tabs need a handful.
export const MAX_STREAMS = 64;

export function createStream(store, { pollMs = 500, pingMs = 15000, maxClients = MAX_STREAMS } = {}) {
  const clients = new Set();
  let last = 0;
  let timers = [];

  const write = (data) => {
    for (const res of clients) res.write(data);
  };
  const tick = (id) => `event: tick\ndata: ${JSON.stringify({ last_event_id: id })}\n\n`;

  function check() {
    let id;
    try {
      id = lastEventId(store);
    } catch {
      return; // busy or closing: try again next time
    }
    if (id > last) {
      last = id;
      write(tick(id));
    }
  }

  function start() {
    last = lastEventId(store);
    timers = [setInterval(check, pollMs), setInterval(() => write(': ping\n\n'), pingMs)];
  }

  function stop() {
    timers.forEach(clearInterval);
    timers = [];
  }

  return {
    attach(req, res) {
      if (clients.size >= maxClients) throw busy(`${maxClients} live streams are already open. Close some review desk tabs.`);
      if (!clients.size) start();
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      // The first tick tells the client where the log stands right now.
      res.write('retry: 2000\n\n' + tick(lastEventId(store)));
      clients.add(res);
      req.on('close', () => {
        clients.delete(res);
        if (!clients.size) stop();
      });
    },
    close() {
      stop();
      for (const res of clients) res.end();
      clients.clear();
    },
  };
}
