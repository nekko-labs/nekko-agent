// The one-time repositories folder offer, synthetic bridge, hidden isolated
// Electron window that never takes focus. Run with
// NEKKO_LAYOUT_FIXTURE=repo-folder-offer-fixture.tsx NEKKO_LAYOUT_SANDBOX=repo-folder-offer-sandbox.cjs.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Run through layout-evidence-integration.cjs');
const profile = path.join(out, 'profile');
app.setPath('userData', profile);
app.setPath('sessionData', profile);
// Selectors here are constants, so plain JSON quoting is enough.
const js = (v) => JSON.stringify(v);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((r, done) => done({ cancel: !/^(file:|data:|blob:)/.test(r.url) }));
  session.defaultSession.setPermissionRequestHandler((_c, _p, done) => done(false));
  const report = { checks: [], errors: [] };
  const wins = [];
  const capture = async (width, name, journey) => {
    const win = new BrowserWindow({ width, height: 420, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -12000, y: -12000, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    wins.push(win);
    win.on('focus', () => report.errors.push('Unexpected window focus'));
    win.webContents.on('console-message', (e) => { if (e.level === 'error') report.errors.push(e.message); });
    const run = (code) => win.webContents.executeJavaScript(code, true);
    const check = (n, passed) => { report.checks.push({ name: `${name}: ${n}`, passed: !!passed }); if (!passed) throw Error(n); };
    const shot = async (n) => { win.setContentSize(width + 1, 420); await sleep(120); win.setContentSize(width, 420); win.webContents.invalidate(); await sleep(350); fs.writeFileSync(path.join(out, `${name}-${n}.png`), (await win.capturePage(undefined, { stayHidden: true })).toPNG()); };
    const click = (selector) => run(`document.querySelector(${js(selector)}).click()`);
    await win.loadFile(path.join(out, 'index.html'));
    await sleep(800);
    await journey({ run, check, shot, click });
  };
  try {
    for (const [width, name] of [[900, 'desktop'], [390, 'narrow']]) {
      await capture(width, name, async ({ run, check, shot, click }) => {
        check('no offer before a folder is added', await run('!document.querySelector("[data-repo-folder-offer]")'));
        await click('[data-fixture-add]');
        await sleep(500);
        check('daemon asked about the added folder', await run('JSON.stringify(window.integration.calls).includes("/Users/alex/code/billing-app")'));
        check('offer shown with the folder', await run('!!document.querySelector("[data-repo-folder-offer]") && document.body.innerText.includes("/Users/alex/code")'));
        await shot('offer');
        await click('[data-testid=repo-folder-use]');
        await sleep(400);
        check('folder saved and offer ended', await run('JSON.stringify(window.integration.calls).includes(\'"repoCloneDir":"/Users/alex/code","repoCloneDirOffered":true\')'));
        check('offer gone after answering', await run('!document.querySelector("[data-repo-folder-offer]")'));
        await shot('answered');
      });
    }
  } catch (e) {
    report.errors.push(String(e && e.stack || e));
  } finally {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    for (const w of wins) w.destroy();
    app.exit(report.errors.length ? 1 : 0);
  }
});
