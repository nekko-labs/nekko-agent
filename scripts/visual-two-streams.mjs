// Visual check for #551: two chats streaming at once in the web edition, on
// the Agents wall, in headless Playwright Chromium. An isolated scratch data
// dir and ports, a mock model, nothing of the user's touched; every process
// tree started here is ended on exit.
//
//   node scripts/visual-two-streams.mjs --app <checkout> --out <dir> [--label before]
//
// Records, at mid-stream and after both end: screenshots, each window's reply
// text (to prove both render and nothing is doubled), the sidebar and wall
// working indicators, and how many agent frames the page's socket received
// for each chat.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { connectCdp } from './perf/lib/cdp.mjs';
import { killTree, launchBrowser } from './perf/lib/browser.mjs';
import { startMockProvider, STREAM_TRIGGER } from './perf/lib/mock-provider.mjs';
import { seedDataDir } from './perf/lib/seed.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const APP = resolve(opt('app', resolve(import.meta.dirname, '..')));
const OUT = resolve(opt('out', '.shots/i551'));
const LABEL = opt('label', 'after');
const base = Number(opt('port', 4620));
const mockPort = base, appPort = base + 1, cdpPort = base + 2;
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanups = [];
const cleanup = async () => { while (cleanups.length) { try { await cleanups.pop()(); } catch { /* best effort */ } } };
process.on('SIGINT', async () => { await cleanup(); process.exit(130); });

const mock = await startMockProvider({ port: mockPort, tokensPerSecond: 60, replyTokens: 500 });
cleanups.push(() => mock.close());
// Six chats on the wall, small transcripts; two of them will stream.
const { dir: data, ids } = seedDataDir({ mockPort, chats: [6, 6, 6, 6, 6, 6] });
cleanups.push(() => rmSync(data, { recursive: true, force: true }));
const server = spawn(process.execPath, [join(APP, 'apps/server/dist/index.js')], {
  cwd: APP,
  env: { ...process.env, NEKKO_DATA_DIR: data, NEKKO_PORT: String(appPort), NEKKO_HOST: '127.0.0.1', NEKKO_DAEMON: 'nekkod' },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));
cleanups.push(() => killTree(server));
const appUrl = `http://127.0.0.1:${appPort}/`;
const api = async (channel, ...args) => {
  const r = await fetch(`${appUrl}api/${channel}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ args }) });
  const t = await r.text();
  return t ? JSON.parse(t) : null;
};

try {
  let up = false;
  for (let i = 0; i < 160 && !up; i++) { try { up = !!(await api('settings:get')); } catch { await sleep(250); } }
  if (!up) throw new Error(`server did not start:\n${serverLog.slice(-2000)}`);
  const caps = await api('web:capabilities');
  console.log(`[${LABEL}] engine ${caps?.engine}`);

  const browser = await launchBrowser({ port: cdpPort, width: 1600, height: 1000, vsync: true });
  cleanups.push(() => browser.close());
  const cdp = await connectCdp(browser.wsUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  const pane = (refId, n) => ({ id: `pane_${n}`, kind: 'chat', refId });
  // The wall shows chats 0-3; 4 and 5 are only in the sidebar.
  const wall = { layout: { mode: 'grid', cols: 2, rows: 2 }, dock: { side: 'right', show: false, panels: {}, minimized: {} },
    root: { id: 'split_c', dir: 'col', sizes: [0.5, 0.5], children: [
      { id: 'split_a', dir: 'row', sizes: [0.5, 0.5], children: [pane(ids[0], 1), pane(ids[1], 2)] },
      { id: 'split_b', dir: 'row', sizes: [0.5, 0.5], children: [pane(ids[2], 3), pane(ids[3], 4)] },
    ] }, autoAdd: false, filter: 'all', insights: { panels: {} }, watermark: Date.now() };
  // Count the agent frames the page's own event socket receives, per chat.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    try { localStorage.setItem('nekko.commandWall', ${JSON.stringify(JSON.stringify(wall))}); } catch {}
    window.__frames = {};
    const W = window.WebSocket;
    window.WebSocket = class extends W {
      constructor(...a) { super(...a); if (String(a[0]).includes('/api/events')) this.addEventListener('message', (e) => {
        try { const f = JSON.parse(e.data); const id = f.payload && f.payload.sessionId; if (!id) return;
          const k = f.channel === 'agent:replay' ? id + ':replay' : id; window.__frames[k] = (window.__frames[k] || 0) + 1; } catch {}
      }); }
    };` });
  await cdp.send('Page.navigate', { url: appUrl });
  for (let i = 0; i < 120; i++) {
    if (await cdp.evaluate(`document.querySelectorAll('.panel').length >= 4`)) break;
    await sleep(250);
  }
  await sleep(1500);
  const shot = async (name) => writeFileSync(join(OUT, `${LABEL}-${name}.png`), Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await shot('idle');

  // Two chats on the wall stream at once (the server's own chat:send, as a
  // queued follow-up or a watch would start them: the page did not send).
  const started = [ids[0], ids[1]].map((sid) => api('chat:send', { sessionId: sid, providerId: 'mock', modelId: 'mock-1', text: `${STREAM_TRIGGER} please, chat ${sid}` }));
  // And one chat that is only in the sidebar.
  started.push(api('chat:send', { sessionId: ids[4], providerId: 'mock', modelId: 'mock-1', text: `${STREAM_TRIGGER} in the background` }));
  await sleep(3500);
  const state = () => cdp.evaluate(`(() => {
    const panels = [...document.querySelectorAll('.panel')].map((p) => ({
      title: (p.querySelector('[title]')?.getAttribute('title') || '').slice(0, 40),
      working: !!p.querySelector('[data-agent-status] [aria-label="Working"]') || p.hasAttribute('data-wall-working'),
      replyChars: [...p.querySelectorAll('.msg-ai, [data-live-turn], .live-turn')].reduce((n, e) => n + e.textContent.length, 0),
      text: p.innerText.slice(-4000),
    }));
    return { panels, sidebarWorking: document.querySelectorAll('aside [aria-label="Working"], nav [aria-label="Working"], [aria-label="Working"]').length, frames: window.__frames };
  })()`);
  const mid = await state();
  await shot('mid-stream');
  await Promise.all(started);
  await sleep(2500);
  const end = await state();
  await shot('done');

  // Doubling check: the same 60-char span of a reply must not appear twice in its window.
  const doubled = (text) => {
    for (let i = 0; i + 60 < text.length; i += 37) {
      const span = text.slice(i, i + 60);
      if (/\S{10}/.test(span) && text.indexOf(span, i + 60) >= 0) return span;
    }
    return null;
  };
  const report = {
    label: LABEL, app: APP, engine: caps?.engine,
    mid: { sidebarWorking: mid.sidebarWorking, panels: mid.panels.map(({ text, ...p }) => p), frames: mid.frames },
    end: { sidebarWorking: end.sidebarWorking, panels: end.panels.map(({ text, ...p }) => ({ ...p, doubled: doubled(text) })), frames: end.frames },
  };
  writeFileSync(join(OUT, `${LABEL}-report.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (e) {
  console.error(e);
  console.error(serverLog.slice(-3000));
  process.exitCode = 1;
} finally {
  await cleanup();
  setTimeout(() => process.exit(process.exitCode ?? 0), 500);
}
