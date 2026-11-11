// `grapim hub`: start the team cloud service from environment variables.

import { ConfigError, loadConfig } from './config.js';
import { createHub } from './server.js';

export { createHub, loadConfig };

// Returns 1 (with a message on stderr) when the configuration is incomplete,
// otherwise null: the server keeps the process alive.
export async function startHub(env = process.env) {
  let config;
  try {
    config = loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    throw err;
  }
  const hub = await createHub({ config, env });
  const addr = await hub.listen();
  process.stdout.write(
    `grapim hub listening on ${addr.address}:${addr.port}, public at ${config.origin}` +
      ` (data in ${config.dataDir}, billing ${hub.billing ? 'on' : 'off'})\n`,
  );
  const stop = () => hub.close().then(() => process.exit(0));
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  return null;
}
