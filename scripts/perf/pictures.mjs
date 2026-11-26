#!/usr/bin/env node
/**
 * Pictures on demand, measured (docs/decisions/0123, spec/chat/chat-pictures-on-demand.md).
 *
 * Seeds a scratch data dir with two synthetic chats, in the store's own format
 * (pictures beside the chat, `nekko-blob:` references in it):
 *   - Perf chat 01: a 400-message agent chat with 50 tool screenshots and 6
 *     pictures the user attached (every one a distinct, decodable PNG);
 *   - Perf chat 00: a 400-message text chat.
 * Starts the Local Web UI of the checkout named by --app (against the nekkod
 * named by --daemon), then reports:
 *   1. `session:get` bytes and time, default (every picture inline) and with
 *      `{ pictures: 'refs' }`, median of --runs calls over HTTP;
 *   2. opening each chat in a fresh headless Chromium, --runs times: time from
 *      the click to the newest reply painted (`__perf.armSwitch`), the JS heap
 *      after a forced GC two seconds later, and the `session:blob` calls the
 *      page made.
 *
 *   node scripts/perf/pictures.mjs --app <checkout> [--daemon <nekkod>] [--runs 5] [--label base] [--json out.json] [--wire-only]
 *
 * Never reads ~/.nekko-agent: the data dir is a fresh temp dir.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectCdp } from './lib/cdp.mjs';
import { killTree, launchBrowser } from './lib/browser.mjs';
import { INSTALL, locate } from './lib/probes.mjs';
import { seedDataDir, chatTitle, lastMarker } from './lib/seed.mjs';
import { transcript } from './lib/content.mjs';
import { selectWallView } from '../../apps/desktop/scripts/wall-view-navigation.cjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const require = createRequire(join(ROOT, 'package.json'));
const { PNG } = require('pngjs');

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const APP = resolve(opt('app', ROOT));
const RUNS = Number(opt('runs', 5));
const LABEL = opt('label', 'run');
const PORTS = { app: Number(opt('app-port', 4492)), cdp: Number(opt('cdp-port', 9491)) };
const SHOTS = 50;
const USER_PICTURES = 6;
const MESSAGES = 400;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[pictures ${LABEL}]`, ...a);
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const cleanups = [];

/** A deterministic 1280x720 screenshot-like PNG (about 280 KB), distinct for each seed. */
function shot(seed) {
  let a = seed >>> 0;
  const r = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const w = 1280, h = 720;
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      png.data[i] = 30 + (y >> 3);
      png.data[i + 1] = 34 + ((x >> 4) % 40);
      png.data[i + 2] = 48;
      png.data[i + 3] = 255;
    }
  }
  for (let k = 0; k < 40; k++) {
    const x0 = Math.floor(r() * w * 0.8), y0 = Math.floor(r() * h * 0.8);
    const ww = 40 + Math.floor(r() * 300), hh = 20 + Math.floor(r() * 120);
    const c = [r() * 255, r() * 255, r() * 255];
    for (let y = y0; y < Math.min(h, y0 + hh); y++) for (let x = x0; x < Math.min(w, x0 + ww); x++) {
      const i = (y * w + x) * 4;
      png.data[i] = c[0]; png.data[i + 1] = c[1]; png.data[i + 2] = c[2];
    }
  }
  for (let y = 0; y < h; y++) if (r() < 0.08) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    png.data[i] ^= (r() * 255) | 0; png.data[i + 1] ^= (r() * 255) | 0; png.data[i + 2] ^= (r() * 255) | 0;
  }
  return PNG.sync.write(png);
}

/** Write `bytes` as a blob beside the chats and return the reference the chat file holds. */
function keep(blobs, bytes) {
  const name = `${createHash('sha256').update(bytes).digest('hex')}.png`;
  writeFileSync(join(blobs, name), bytes);
  return `nekko-blob:${name}`;
}

function seed() {
  const { dir: data } = seedDataDir({ mockPort: 4391, chats: [MESSAGES] });
  const sessions = join(data, 'sessions');
  const blobs = join(sessions, 'blobs');
  mkdirSync(blobs, { recursive: true });
  const messages = transcript({
    seed: 1001,
    count: MESSAGES,
    marker: (turn, newest) => (newest ? lastMarker(1) : `[perf-1-${turn}]`),
  });
  const tools = messages.filter((m) => m.role === 'tool');
  const users = messages.filter((m) => m.role === 'user');
  const spread = (list, n) => list.filter((_, i) => i % Math.floor(list.length / n) === 0).slice(0, n);
  spread(tools, SHOTS).forEach((m, i) => { m.toolResult.images = [keep(blobs, shot(100 + i))]; });
  spread(users, USER_PICTURES).forEach((m, i) => { m.images = [keep(blobs, shot(900 + i))]; });
  const now = Date.now();
  const session = {
    id: 's_perf_01', title: chatTitle(1), titleAuto: false, providerId: 'mock', modelId: 'mock-1', mode: 'yolo',
    messages, createdAt: now - 86_400_000, updatedAt: now - 60_000,
  };
  writeFileSync(join(sessions, 's_perf_01.json'), JSON.stringify(session));
  return { data, ids: ['s_perf_00', 's_perf_01'] };
}

async function startApp(data) {
  const env = { ...process.env, NEKKO_DATA_DIR: data, NEKKO_PORT: String(PORTS.app), NEKKO_HOST: '127.0.0.1' };
  const daemon = opt('daemon', null);
  if (daemon) env.NEKKOD_PATH = resolve(daemon);
  const server = spawn(process.execPath, [join(APP, 'apps/local-web-ui/dist/index.js')], {
    cwd: APP, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  let out = '';
  server.stdout.on('data', (d) => (out += d));
  server.stderr.on('data', (d) => (out += d));
  cleanups.push(() => killTree(server));
  const url = `http://127.0.0.1:${PORTS.app}/`;
  const api = (channel, ...args) =>
    fetch(`${url}api/${channel}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ args }) });
  for (let i = 0; i < 120; i++) {
    try { if ((await api('settings:get')).ok) return { url, api, banner: out }; } catch { /* starting */ }
    await sleep(250);
  }
  throw new Error(`the Local Web UI did not start:\n${out.slice(-2000)}`);
}

/** `session:get` over HTTP: bytes of the body and wall time, `runs` calls after one warm-up, median. */
async function measureGet(api, id, extra) {
  const times = [], sizes = [];
  for (let i = 0; i < RUNS + 1; i++) {
    const t = performance.now();
    const body = Buffer.from(await (await api('session:get', id, ...extra)).arrayBuffer());
    const ms = performance.now() - t;
    if (i > 0) { times.push(ms); sizes.push(body.length); }
  }
  return { bytes: median(sizes), ms: Number(median(times).toFixed(1)), samples: times.map((x) => Number(x.toFixed(1))) };
}

/** Open each chat in a fresh browser: paint time, then heap after a settle and a forced GC. */
async function openOnce(url, index) {
  const browser = await launchBrowser({ port: PORTS.cdp + index * 10, width: 1440, height: 900, vsync: false, gpu: true });
  const cdp = await connectCdp(browser.wsUrl);
  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url });
    const waitFor = async (expr, what, ms = 30000) => {
      for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await cdp.evaluate(expr)) return;
      throw new Error(`timed out waiting for ${what}`);
    };
    await waitFor(`!!document.querySelector('nav button[aria-label="Agents"]')`, 'the app shell');
    await cdp.evaluate(INSTALL);
    const click = async ({ x, y }) => {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    };
    await click(await cdp.call(locate, 'nav button[aria-label="Agents"]', null));
    await waitFor(`!!document.querySelector('button[data-sidebar-group]')`, 'the Agents sidebar');
    await selectWallView((source) => cdp.evaluate(source), 'focus', () => sleep(100));
    const results = {};
    for (const [key, i] of [['text', 0], ['agent', 1]]) {
      const title = chatTitle(i);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1420, y: 20 });
      await sleep(350);
      await cdp.evaluate(`for (const h of document.querySelectorAll('button[aria-expanded="false"][data-sidebar-group]')) h.click()`);
      await waitFor(`[...document.querySelectorAll('div[role="button"]')].some((c) => c.getAttribute('title')?.includes(${JSON.stringify(title)}))`, `the card for ${title}`);
      await cdp.call((t, m) => window.__perf.armSwitch(t, m), title, lastMarker(i));
      await click(await cdp.call(locate, 'div[role="button"]', title));
      let res = null;
      for (let k = 0; k < 800 && !res; k++) { res = await cdp.evaluate('window.__perf.switchResult'); if (!res) await sleep(25); }
      if (!res || res.timeout) throw new Error(`opening ${title} did not paint: ${JSON.stringify(res)}`);
      await sleep(2000);
      await cdp.send('HeapProfiler.enable');
      await cdp.send('HeapProfiler.collectGarbage');
      await cdp.send('HeapProfiler.collectGarbage');
      const heap = await cdp.send('Runtime.getHeapUsage');
      const blobCalls = await cdp.evaluate(`performance.getEntriesByType('resource').filter((e) => e.name.includes('session:blob')).length`);
      results[key] = { switch: res, heapMB: Number((heap.usedSize / 1048576).toFixed(1)), blobCalls };
    }
    return results;
  } finally {
    try { cdp.close(); } catch { /* gone */ }
    await browser.close();
  }
}

async function main() {
  const { data, ids } = seed();
  cleanups.push(() => rmSync(data, { recursive: true, force: true }));
  log(`scratch data dir ${data}`);
  try {
    const { url, api, banner } = await startApp(data);
    log(banner.split('\n').filter((l) => /engine:|data dir/.test(l)).join(' | '));
    const wire = {};
    for (const [key, id] of [['text', ids[0]], ['agent', ids[1]]]) {
      wire[key] = { inline: await measureGet(api, id, []), refs: await measureGet(api, id, [{ pictures: 'refs' }]) };
      log(`session:get ${key}: inline ${wire[key].inline.bytes} B ${wire[key].inline.ms} ms; refs ${wire[key].refs.bytes} B ${wire[key].refs.ms} ms`);
    }
    const opens = [];
    if (!argv.includes('--wire-only')) {
      for (let i = 0; i < RUNS; i++) { opens.push(await openOnce(url, i)); log(`open ${i + 1}/${RUNS}`, JSON.stringify(opens[i])); }
    }
    const report = { label: LABEL, app: APP, runs: RUNS, wire, opens };
    console.log(JSON.stringify(report, null, 2));
    if (opt('json', null)) writeFileSync(opt('json'), JSON.stringify(report, null, 2));
  } finally {
    while (cleanups.length) { try { await cleanups.pop()(); } catch { /* best effort */ } }
  }
}

main().catch((e) => { console.error(e); process.exit(2); });
