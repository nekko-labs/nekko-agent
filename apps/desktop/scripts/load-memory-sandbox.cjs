// Launched by layout-evidence-integration.cjs with load-memory-fixture.tsx.
const { app, BrowserWindow, session, screen } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', fs.mkdtempSync(path.join(out, 'profile-')));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const report = { captures: [], checks: [], errors: [] };
  session.defaultSession.webRequest.onBeforeRequest((req, done) => done({ cancel: !/^(file:|data:|blob:)/.test(req.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  const displays = screen.getAllDisplays().map(d => d.bounds);
  const x = Math.min(...displays.map(d => d.x));
  const y = Math.min(...displays.map(d => d.y));
  const win = new BrowserWindow({ width: 1280, height: 800, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: x - 3000, y: y - 1600, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('Fixture took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const run = source => win.webContents.executeJavaScript(source);
  const wait = async (source) => {
    for (let i = 0; i < 60; i++) { if (await run(source)) return; await sleep(100); }
    throw Error(`Timed out: ${source}`);
  };
  const select = id => run(`loadMemoryFixture.select(${JSON.stringify(id)})`);
  const segment = (pool, part) => `document.querySelector('[data-meter-configuration] [data-meter-bar="${pool}"] [data-segment="${part}"]')`;
  const contextWidth = pool => `parseFloat(${segment(pool, 'context')}?.style.width ?? '0')`;
  const moveContext = () => run(`(() => {
    const slider = document.getElementById('engine-ctx');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(slider, '3');
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  const capture = async (name, width = 1280) => {
    win.setContentSize(width, 800);
    await wait(`innerWidth === ${width}`);
    assert(await run(`(() => {
      const primary = document.querySelector('[data-meter-configuration]');
      const graph = primary?.querySelector('[data-memory-bar]');
      const total = primary?.querySelector('[data-meter-total]');
      return graph && total && !graph.closest('details') && graph.getBoundingClientRect().bottom <= total.getBoundingClientRect().top &&
        graph.getBoundingClientRect().width > 0 && graph.getBoundingClientRect().bottom <= innerHeight;
    })()`), `Primary graph is not visible above the total: ${name}`);
    await sleep(450);
    const image = await win.capturePage(undefined, { stayHidden: true });
    assert(!image.isEmpty(), `Empty capture: ${name}`);
    fs.writeFileSync(path.join(out, `${name}.png`), image.toPNG());
    report.captures.push(`${name}.png`);
  };
  try {
    const bounds = win.getBounds();
    assert(!win.isVisible() && !win.isFocused() && !win.isFocusable() && bounds.x + bounds.width < x && bounds.y + bounds.height < y);
    await win.loadFile(path.join(out, 'index.html'));
    await wait('!!window.loadMemoryFixture');
    for (const [id, pool] of [['gguf', 'vram'], ['hermes', 'mlx-context']]) {
      await select(id);
      await wait(contextWidth(pool));
      const before = await run(contextWidth(pool));
      await capture(`${id}-initial`);
      await moveContext();
      await wait(`${contextWidth(pool)} > ${before}`);
      report.checks.push({ model: id, initialWidth: before, changedWidth: await run(contextWidth(pool)) });
      await capture(`${id}-32k`);
    }
    for (const [id, unknown] of [['partial', 'Context memory'], ['image', 'Supporting files in memory']]) {
      await select(id);
      await wait(`${segment('disk', 'weights')} && document.querySelector('[data-meter]').textContent.includes(${JSON.stringify(unknown)})`);
      assert(await run(`document.querySelector('[data-meter-total]').textContent.includes('Unknown') && !document.querySelector('[data-meter] [data-segment="context"]')`));
      report.checks.push({ model: id, diskWeights: true, unknown });
      await capture(`${id}-narrow`, 390);
    }
  } catch (e) {
    report.errors.push(String(e.stack || e));
  } finally {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    app.exit(report.errors.length ? 1 : 0);
  }
});
