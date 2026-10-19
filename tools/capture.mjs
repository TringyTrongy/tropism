// Headless screenshots for design review, driven over the Chrome DevTools Protocol
// so phone widths get real device emulation (desktop Chrome windows cannot go below ~500px).
//
//   node tools/capture.mjs <out.png> <width> <height> [query] [options]
//     query     appended to the dev-server URL, e.g. "debug=900&pause&theme=dark"
//     options   comma list: full (whole page), mobile (touch + mobile viewport), dpr=2, wait=1500, port=5173
//
// Uses an isolated, throwaway Chrome profile, so the user's own browser profile is never touched.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const [out, width = '1440', height = '900', query = 'debug=900&pause', optStr = ''] = process.argv.slice(2);
if (!out) {
  console.error('usage: node tools/capture.mjs <out.png> <width> <height> [query] [full,mobile,dpr=2,wait=1500,port=5173]');
  process.exit(2);
}
const opts = Object.fromEntries(optStr.split(',').filter(Boolean).map((kv) => {
  const [k, v] = kv.split('=');
  return [k, v === undefined ? true : v];
}));
const port = opts.port || '5173';
const W = Number(width);
const H = Number(height);
const dpr = Number(opts.dpr || 1);
const waitMs = Number(opts.wait || 1500);

const candidates = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const browserPath = candidates.find((p) => existsSync(p));
if (!browserPath) {
  console.error('No Chromium browser found.');
  process.exit(1);
}

const profile = mkdtempSync(join(tmpdir(), 'tropism-capture-'));
const proc = spawn(browserPath, [
  '--headless=new',
  '--hide-scrollbars',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-sync',
  '--remote-debugging-port=0',
  `--user-data-dir=${profile}`,
  '--use-angle=d3d11',
  '--window-size=1600,1000',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

const cleanup = () => {
  proc.once('exit', () => {
    // Chrome can hold profile files for a moment after exit on Windows; a leftover temp dir is harmless.
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* leave it */ }
  });
  try { proc.kill(); } catch { /* already gone */ }
};

const wsUrl = await new Promise((res, rej) => {
  let buf = '';
  const timer = setTimeout(() => rej(new Error('Chrome did not start')), 20000);
  proc.stderr.on('data', (d) => {
    buf += d;
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) { clearTimeout(timer); res(m[1]); }
  });
});

const ws = new WebSocket(wsUrl);
await new Promise((res) => ws.addEventListener('open', res, { once: true }));
let nextId = 1;
const pending = new Map();
const listeners = [];
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) rej(new Error(msg.error.message)); else res(msg.result);
  } else if (msg.method) {
    for (const l of listeners) l(msg);
  }
});
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = nextId++;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});

try {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p) => send(m, p, sessionId);
  await s('Page.enable');
  await s('Runtime.enable');
  await s('Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: dpr, mobile: Boolean(opts.mobile),
    screenWidth: W, screenHeight: H,
  });
  if (opts.mobile) await s('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const errors = [];
  listeners.push((msg) => {
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
  });
  const loaded = new Promise((res) => listeners.push((msg) => { if (msg.method === 'Page.loadEventFired') res(); }));
  const url = `http://localhost:${port}/?${query}`;
  await s('Page.navigate', { url });
  await loaded;
  // ?debug pages advance the dish in the simulation worker, after load; wait until the page
  // says those steps are on screen (window.__tropism.ready), for at most a minute.
  await s('Runtime.evaluate', {
    expression: 'Promise.race([Promise.resolve(window.__tropism && window.__tropism.ready), new Promise((r) => setTimeout(r, 60000))]).then(() => true)',
    awaitPromise: true,
    returnByValue: true,
  });
  await new Promise((r) => setTimeout(r, waitMs));

  let clip;
  if (opts.full) {
    const m = await s('Page.getLayoutMetrics');
    const size = m.cssContentSize || m.contentSize;
    clip = { x: 0, y: 0, width: W, height: Math.ceil(size.height), scale: 1 };
  } else if (opts.y) {
    // A viewport-sized window of the page starting at document offset y.
    clip = { x: 0, y: Number(opts.y), width: W, height: H, scale: 1 };
  }
  const beyond = Boolean(opts.full || opts.y);
  const shot = await s('Page.captureScreenshot', { format: 'png', captureBeyondViewport: beyond, ...(clip ? { clip } : {}) });
  writeFileSync(resolve(out), Buffer.from(shot.data, 'base64'));
  const overflow = await s('Runtime.evaluate', {
    expression: 'JSON.stringify({ docW: document.documentElement.scrollWidth, vw: innerWidth, docH: document.documentElement.scrollHeight, simClock: (document.getElementById("clock-t") || {}).textContent })',
    returnByValue: true,
  });
  console.log(`captured ${out} ${W}x${H}${opts.full ? ' full' : ''} ${overflow.result.value}`);
  if (errors.length) console.log('page errors:\n  ' + errors.join('\n  '));
} catch (err) {
  console.error('capture failed:', err.message);
  process.exitCode = 1;
} finally {
  ws.close();
  cleanup();
}
