#!/usr/bin/env node
// Keep Node's notice about the built-in SQLite module out of hook output,
// which Claude Code shows to the agent.
process.removeAllListeners('warning');
const { main } = await import('../src/cli.js');
const code = await main(process.argv.slice(2));
if (typeof code === 'number') process.exitCode = code;
