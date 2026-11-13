// node shot.mjs <url> <out.png> <width> <height> <light|dark> [js-to-run-before-shot] [--full]
// Prints console errors and exceptions. JS may return a value; it is printed.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const args = process.argv.slice(2).filter((a) => a !== '--full');
const full = process.argv.includes('--full');
const [url, out, w = '1440', h = '900', scheme = 'light', js = ''] = args;
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'));
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--remote-debugging-port=0',
  `--user-data-dir=${prof}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, port;
for (let i = 0; i < 80 && !port; i++) {
  try { port = Number(fs.readFileSync(path.join(prof, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch {}
  if (!port) await sleep(150);
}
for (let i = 0; i < 60; i++) {
  try { const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const p = list.find((t) => t.type === 'page'); if (p) { ws = p.webSocketDebuggerUrl; break; } } catch {}
  await sleep(200);
}
const sock = new WebSocket(ws);
await new Promise((r) => sock.addEventListener('open', r));
let id = 0; const pending = new Map();
sock.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') console.log('EXCEPTION', m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) console.log('CONSOLE', m.params.type, m.params.args.map((a) => a.value ?? a.description).join(' '));
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') console.log('LOG', m.params.entry.text, m.params.entry.url || '');
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); });
const mobile = Number(w) < 768;
await send('Runtime.enable');
await send('Log.enable');
await send('Emulation.setDeviceMetricsOverride', { width: Number(w), height: Number(h), deviceScaleFactor: 1, mobile });
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
await send('Page.enable');
if (process.env.PRE) await send('Page.addScriptToEvaluateOnNewDocument', { source: fs.readFileSync(process.env.PRE, 'utf8') });
await send('Page.navigate', { url });
await sleep(Number(process.env.WAIT || 2500));
if (js) {
  const r = await send('Runtime.evaluate', { expression: js, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) console.error('JS ERR', r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  else if (r.result?.result?.value !== undefined) console.log('RESULT', typeof r.result.result.value === 'string' ? r.result.result.value : JSON.stringify(r.result.result.value, null, 1));
  await sleep(Number(process.env.AFTER || 700));
}
let clip;
if (full) {
  const m = await send('Page.getLayoutMetrics');
  const cs = m.result.cssContentSize || m.result.contentSize;
  clip = { x: 0, y: 0, width: Number(w), height: Math.min(cs.height, 6000), scale: 1 };
}
const shot = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip, captureBeyondViewport: true } : {}) });
if (out !== '-') fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
sock.close(); chrome.kill();
console.log('saved', out);
process.exit(0);
