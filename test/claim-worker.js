// Used by concurrency.test.js: one process, one claim attempt.
process.removeAllListeners('warning');
const { Store } = await import('../src/store.js');
const [stateDir, agent, ...files] = process.argv.slice(2);
const s = new Store(stateDir);
const r = s.claim(agent, files.map((p) => ({ key: p, display: p })));
s.close();
process.stdout.write(JSON.stringify({ agent, ok: r.ok, claimed: r.claimed }));
