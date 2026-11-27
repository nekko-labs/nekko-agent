const { app, BrowserWindow, screen, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
assert(out, 'Launch with model-details-integration.cjs');
const profile = fs.mkdtempSync(path.join(out, 'profile-'));
app.setPath('userData', profile);
app.setPath('sessionData', profile);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const x = Math.min(...screen.getAllDisplays().map(d => d.bounds.x)) - 4000;
  const y = Math.min(...screen.getAllDisplays().map(d => d.bounds.y)) - 3000;
  session.defaultSession.webRequest.onBeforeRequest((r, done) => done({ cancel: !/^(file:|data:|blob:)/.test(r.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ x, y, width: 1280, height: 1100, useContentSize: true, title: 'Isolated Model Details verification', show: false, focusable: false, skipTaskbar: true, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const run = source => win.webContents.executeJavaScript(source);
  const verify = async (name, source) => { assert(await run(source), name); console.log(name); };
  const capture = async name => { const img = await win.capturePage(undefined, { stayHidden: true, stayAwake: false }); assert(!img.isEmpty()); fs.writeFileSync(path.join(out, `${name}.png`), img.toPNG()); };
  const ctx = `document.querySelector('[data-context-control]')`;
  const slider = `${ctx}.querySelector('input')`;
  const allocation = `document.querySelector('[data-allocation-bar]')`;
  try {
    assert(!win.isVisible() && !win.isFocused());
    await win.loadFile(path.join(out, 'index.html'));
    await wait(250);
    await run(`document.querySelector('[data-model-family]').click()`);
    await wait(270);
    await run(`document.querySelector('[data-model-row-toggle]').click()`);
    await wait(640);
    await verify('installed model details and context estimate visible', `${ctx}.innerText.includes('256k') && ${allocation}.innerText.includes('Unified memory') && !!document.querySelector('#model-source')`);
    await capture('models-details-dark');
    await run(`detailFixture.theme('light')`);
    await wait(170);
    await capture('models-details-light');
    if (out.endsWith('after')) {
      const reset = `${ctx}.querySelector('[data-context-reset]')`;
      const marker = `${ctx}.querySelector('[data-context-recommendation]')`;
      const key = k => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: k }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: k }); };
      await verify('details heading, related builds rule, and a selected recommendation', `[...document.querySelectorAll('h3')].some(h=>h.textContent === 'Model Details') && !!document.querySelector('#model-source').closest('div').previousElementSibling.matches('hr') && ${marker} && ${reset}.disabled`);
      await run(`${slider}.focus()`); key('Left'); await wait(400);
      await verify('keyboard edit leaves marker and enables context reset', `${slider}.getAttribute('aria-valuetext').includes('128k') && ${marker}.textContent.includes('Recommended') && !${reset}.disabled`);
      await run(`${reset}.click()`); await wait(400);
      await verify('reset restores context only', `${slider}.getAttribute('aria-valuetext').includes('256k') && ${reset}.disabled`);
      await run(`detailFixture.theme('dark'); document.querySelector('[data-fold=more]').click()`);
      await wait(320);
      const sessions = `document.querySelector('#engine-sessions')`;
      await run(`${sessions}.focus()`); key('Right'); await wait(450);
      await verify('parallel cache label and total update at the same per-session context', `${allocation}.innerText.includes('2 sessions × 256k') && ${ctx}.innerText.includes('512k total')`);
      await run(`${slider}.focus()`); key('Left'); await wait(360);
      await capture('models-details-parallel');
      await run(`${reset}.click()`); await wait(400);
      await verify('context reset preserves the selected parallel count', `${allocation}.innerText.includes('2 sessions × 256k') && ${ctx}.innerText.includes('512k total')`);
    }
  } catch (e) { console.error(e); app.exit(1); return; }
  app.exit(0);
});
