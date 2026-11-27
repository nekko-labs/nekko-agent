// Use layout-evidence-integration.cjs with this sandbox and budget-accounting-fixture.tsx.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((r, done) => done({ cancel: !/^(file:|data:|blob:)/.test(r.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const report = [];
  for (const width of [360, 520]) {
    const win = new BrowserWindow({ width, height: 560, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
    const run = s => win.webContents.executeJavaScript(s);
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 50 && !(await run('!!document.querySelector(".monitors-dock__budget")')); i++) await sleep(100);
    await run('document.fonts.ready.then(() => true)');
    // Let the existing dock entrance finish before reading pixels.
    await sleep(350);
    const layout = await run(`(() => {
      const dock = document.querySelector('.monitors-dock').getBoundingClientRect();
      const card = document.querySelector('[data-monitor="budget"]').getBoundingClientRect();
      return { width: innerWidth, height: innerHeight, x: dock.x, right: dock.right, bottom: card.bottom };
    })()`);
    assert.equal(layout.width, width);
    assert.ok(layout.x >= -0.5 && layout.right <= layout.width && layout.bottom <= layout.height, JSON.stringify(layout));
    const text = await run('document.querySelector(".monitors-dock__budget").innerText');
    const row = await run(`document.querySelector('[data-row="top"] dd').innerText`);
    assert.match(row, /Sketch the kites/);
    assert.match(text, /\$0\.42/);
    assert.match(text, /940,000 tokens/);
    assert.equal(win.isVisible(), false);
    fs.writeFileSync(path.join(out, `budget-${width}.png`), (await win.capturePage(undefined, { stayHidden: true })).toPNG());
    if (process.env.NEKKO_BUDGET_AFTER === '1') {
      assert.match(text, /Estimated savings/);
      assert.match(text, /Local model savings\s+\$1\.23/);
      const { x, y } = await run(`(() => {
        const r = document.querySelector('[data-row="top"] button').getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`);
      win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x, y });
      win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x, y });
      await sleep(100);
      assert.equal(await run('document.body.dataset.openedChat'), 'kites');
    }
    report.push({ layout, text, openedChat: await run('document.body.dataset.openedChat ?? null') });
    win.destroy();
  }
  console.log(JSON.stringify(report, null, 2));
  app.exit(0);
}).catch(e => { console.error(e); app.exit(1); });
