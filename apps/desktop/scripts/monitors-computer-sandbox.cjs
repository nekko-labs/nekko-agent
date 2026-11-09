// The Monitors panel watching a connected computer: Hardware, Local models and
// Utilization all read the computer chosen in its switch. Run through
// layout-evidence-integration.cjs (NEKKO_LAYOUT_SANDBOX=monitors-computer-sandbox.cjs);
// NEKKO_TEST_SOURCE can point at an unchanged base tree for the "before" captures.
// Hidden, off-screen, non-focusable window, isolated profile, network blocked.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const js = value => JSON.stringify(value).replace(/</g, '\\u003c');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { scenes: {}, checks: [], errors: [] };
app.disableHardwareAcceleration();
const monitors = { hardware: true, localModels: true, utilization: true, budget: false, automations: false };
const wall = { root: { id: 'mode-pane', kind: 'chat', refId: 'd' }, hero: 'd', watermark: 1, autoAdd: false, layout: { mode: 'focus' }, dock: { side: 'right', monitors, show: true, simpleShow: true }, agentPanel: { show: true }, zonesIntro: true };
const GB = 1024 ** 3;
// This computer: one small model and a ChatGPT plan. gomi: a big model and its own Claude plan.
// Seeded onto the fixture's bridge as it is installed, before any renderer code reads it.
const seed = `Object.defineProperty(window, 'nekko', { configurable: true, set(b) {
  Object.defineProperty(window, 'nekko', { configurable: true, writable: true, value: b });
  const local = { install: { binPath: '/x/llama-server', available: [] }, running: true, port: 11500, log: [], resident: [{ id: 'qwen3-8b', loadedOn: 'gpu', gpuLayers: 36, totalLayers: 36, contextLength: 32768, vramBytes: ${6 * GB} }] };
  b.engineStatus = async () => local;
  b.engineModels = async () => [{ id: 'qwen3-8b', name: 'Qwen3 8B', path: '/m/q.gguf', sizeBytes: ${5 * GB} }];
  b.getLimits = async () => ({ updatedAt: Date.now(), staleAfterMs: 600000, windows: [{ label: '5-hour', usedPercent: 12, resetAt: Date.now() + 3 * 3600e3 }] });
  b.getSystemStats = async () => ({ cpuPct: 14, memUsedMB: 9000, memTotalMB: 32768 });
  b.getGpuStats = async () => ({ usedMB: 6200, totalMB: 24576, devices: [{ name: 'Apple M3 Max', memoryTotalMB: 24576, memoryUsedMB: 6200, memoryFreeMB: 18376, utilizationPct: 22 }] });
  b.computerStats = async () => ({ system: { cpuPct: 71, memUsedMB: 98000, memTotalMB: 131072 }, gpu: { usedMB: 40000, totalMB: 49152, devices: [{ name: 'NVIDIA RTX 6000 Ada', memoryTotalMB: 49152, memoryUsedMB: 40000, memoryFreeMB: 9152, utilizationPct: 93 }] } });
  b.computerEngineStatus = async () => ({ running: true, installed: true, resident: [{ id: 'gpt-oss-120b', loadedOn: 'gpu+cpu', gpuLayers: 30, totalLayers: 36, contextLength: 131072, sizeBytes: ${63 * GB} }], settings: { maxLoaded: 2, idleTtlSeconds: 900, jitLoad: true } });
  b.computerModelServer = async () => ({ ok: true });
  b.computerRead = async (_id, channel, args) => channel === 'models:list' ? [{ id: 'gpt-oss-120b', name: 'gpt-oss 120B' }, { id: 'qwen3-coder-30b', name: 'Qwen3 Coder 30B' }]
    : channel === 'providers:list' ? [{ id: 'claude', kind: 'claude-code', label: 'Claude Agent', enabled: true }]
    : channel === 'limits:get' ? { updatedAt: Date.now(), windows: [{ label: '5-hour', usedPercent: 64, resetAt: Date.now() + 2 * 3600e3 }, { label: '7-day', usedPercent: 31, resetAt: Date.now() + 4 * 86400e3 }] }
    : { daily: [{ date: new Date().toISOString().slice(0, 10), input: 1840000, output: 212000, cost: 0 }] };
  b.listComputers = async () => [{ id: 'gomi', name: 'gomi', state: 'online', color: 0, route: 'tailnet' }];
} });`;
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -10000, y: -10000, title: 'Monitors computer, isolated evidence', webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('show', () => report.errors.push('Window became visible'));
  win.on('focus', () => report.errors.push('Window took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  const run = code => win.webContents.executeJavaScript(code, true);
  await win.loadURL('about:blank');
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Page.enable');
  await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: `if (location.protocol === 'file:') { localStorage.clear(); localStorage.setItem('nekko.chatMode', 'expert'); localStorage.setItem('nekko.commandWall', ${js(JSON.stringify(wall))}); ${seed} }` });
  await win.loadFile(path.join(out, 'index.html'));
  for (let i = 0; i < 80 && !await run('!!(window.layoutFixture && document.querySelector(".monitors-dock"))').catch(() => false); i++) await sleep(100);
  const capture = async (name) => {
    await sleep(1500);
    await run(`document.querySelectorAll('[role="dialog"] button[aria-label^="Close" i], [role="dialog"] button[aria-label^="Skip" i]').forEach(b => b.click())`);
    for (let i = 0; i < 2; i++) { win.webContents.invalidate(); await sleep(600); await win.capturePage(undefined, { stayHidden: true }); }
    const file = path.join(out, `${name}.png`);
    fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG());
    const text = await run(`document.querySelector('.monitors-dock')?.innerText ?? ''`);
    report.scenes[name] = { file, text };
    return text;
  };
  const pick = id => run(`(() => { const s = document.querySelector('select[aria-label^="Computer the"]'); if (!s) return false; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, ${js(id)}); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  try {
    const here = await capture('this-computer');
    report.checks.push({ name: 'The switch shows once a computer is connected', pass: await pick('') });
    await pick('gomi');
    const there = await capture('gomi');
    report.checks.push({ name: 'Hardware reads gomi', pass: /RTX 6000/.test(there) });
    report.checks.push({ name: "Local models reads gomi's engine", pass: /gpt-oss-120b/.test(there) && !/Qwen3 8B/.test(there) });
    report.checks.push({ name: "gomi's Model Server controls show", pass: /Load a model/.test(there) && /Models kept loaded/.test(there) });
    report.checks.push({ name: "Utilization reads gomi's plan", pass: /Claude Agent/.test(there) && !/ChatGPT/.test(there) });
    report.checks.push({ name: 'This computer before switching', pass: /Qwen3 8B/.test(here) && /ChatGPT/.test(here) });
  } catch (e) { report.errors.push(String(e && e.stack || e)); process.exitCode = 1; }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ checks: report.checks, errors: report.errors }, null, 2));
  app.exit(process.exitCode || 0);
});
