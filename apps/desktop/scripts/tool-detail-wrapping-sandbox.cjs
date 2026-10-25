const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_COMPONENT_OUT;
if (!out) throw Error('Launch through tool-detail-wrapping-integration.cjs');
const kind = process.env.NEKKO_TEST_REVISION ? 'before' : 'after';
const dir = path.join(out, kind);
fs.mkdirSync(dir, { recursive: true });
app.setPath('userData', path.join(dir, 'profile'));
app.setPath('sessionData', path.join(dir, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { errors: [], checks: [], captures: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, done) => done(false));
  const win = new BrowserWindow({ width: 960, height: 3000, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -10000, y: -10000, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.on('show', () => report.errors.push('Window became visible'));
  win.on('focus', () => report.errors.push('Window took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = code => win.webContents.executeJavaScript(code, true);
  try {
    await win.loadFile(path.join(out, 'index.html')); await sleep(600);
    await run("document.querySelectorAll('button[aria-expanded=false]').forEach(b => b.click())");
    await sleep(300);
    await run("document.querySelectorAll('button[aria-expanded=false]').forEach(b => b.click())");
    await sleep(300);
    for (const width of [960, 440]) {
      win.setContentSize(width, 3000); await sleep(300);
      const metrics = await run(`Array.from(document.querySelectorAll('pre')).map(p => ({ width: p.clientWidth, scrollWidth: p.scrollWidth, height: p.clientHeight, scrollHeight: p.scrollHeight, wrap: getComputedStyle(p).overflowWrap, whiteSpace: getComputedStyle(p).whiteSpace, text: p.textContent }))`);
      if (metrics.length !== 8) throw Error('Expected eight expanded detail wells, got ' + metrics.length);
      if (kind === 'after' && metrics.some(p => p.scrollWidth > p.width + 1 || p.wrap !== 'anywhere' || p.whiteSpace !== 'pre-wrap')) throw Error('Detail wrapping regression');
      if (kind === 'after' && metrics.some(p => p.height > 288 || p.scrollHeight <= p.height)) throw Error('Expected bounded vertical scroll');
      if (kind === 'after') {
        const baseline = JSON.parse(fs.readFileSync(path.join(out, 'before', 'status.json'), 'utf8')).checks.find(c => c.width === width);
        if (JSON.stringify(metrics.map(p => p.text)) !== JSON.stringify(baseline.metrics.map(p => p.text))) throw Error('Expanded text changed');
        const scrolled = await run("Array.from(document.querySelectorAll('pre')).every(p => { p.scrollTop = 32; const moved = p.scrollTop > 0; p.scrollTop = 0; return moved; })");
        if (!scrolled) throw Error('Vertical scroll interaction failed');
      }
      report.checks.push({ width, metrics });
      const file = path.join(dir, `${kind}-details-${width}.png`);
      fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(file);
    }
    report.background = { visible: win.isVisible(), focused: win.isFocused(), bounds: win.getBounds() };
    if (win.isVisible() || win.isFocused()) throw Error('Background invariant failed');
  } catch (e) { report.errors.push(String(e)); }
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  win.destroy(); app.exit(report.errors.length ? 1 : 0);
});
