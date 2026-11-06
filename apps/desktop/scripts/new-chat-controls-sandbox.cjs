// Real composer, synthetic bridge, hidden window, and no external network access.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const out = process.env.NEKKO_INTEGRATION_OUT;
const before = process.env.NEKKO_TEST_REVISION === 'before';
app.setPath('userData', fs.mkdtempSync(path.join(out, 'profile-')));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], checks: [], errors: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ title: 'Nekko new-chat controls sandbox', width: 1100, height: 800, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const run = async s => { try { return await win.webContents.executeJavaScript(s, true); } catch (e) { throw new Error(`${s}: ${e.message}`); } };
  const shot = async name => { const file = path.join(out, `${before ? 'before' : 'after'}-${name}.png`); fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(file); };
  win.on('focus', () => report.errors.push('Window took focus'));
  try {
    await win.loadFile(path.join(out, 'index.html'));
    await run("localStorage.setItem('nekko.chatMode','expert')");
    await win.reload();
    for (let i = 0; i < 80 && !(await run('!!document.querySelector("[contenteditable=plaintext-only]")')); i++) await sleep(100);
    await run('document.querySelector("[contenteditable=plaintext-only]").focus()');
    await win.webContents.insertText('Make this better and fix everything');
    await sleep(800);
    for (const width of [1100, 420]) {
      win.setContentSize(width, 800); await sleep(350);
      const layout = await run(`(() => { const s=document.querySelector('[data-prompt-suggestions]').getBoundingClientRect(), a=document.querySelector('[data-composer-action]').getBoundingClientRect(); return {width:innerWidth,suggestionTop:s.top,actionBottom:a.bottom,overflow:document.documentElement.scrollWidth>innerWidth}; })()`);
      assert.equal(layout.overflow, false);
      if (!before) assert.ok(layout.suggestionTop >= layout.actionBottom, 'Suggestions below action row');
      report.checks.push(layout); await shot(`composer-${width}`);
      await run('document.querySelector("[data-prompt-suggestions]").click()'); await sleep(150);
      assert.ok(await run(`!!document.querySelector('[aria-label="Prompt suggestions"]')`));
      await run('document.querySelector("[data-prompt-suggestions]").click()');
      await run('document.querySelector("[data-chat-mode-button]").click()'); await sleep(200);
      const menu = await run(`(() => { const p=document.querySelector('[data-mode-panel]'); const r=p.getBoundingClientRect(); return {top:r.top,bottom:r.bottom,viewport:innerHeight,model:p.querySelectorAll('[data-model-scope]').length,effort:p.querySelectorAll('[data-effort]').length,environment:!!p.querySelector('[data-execution]')}; })()`);
      if (!before) { assert.equal(menu.model, 0); assert.equal(menu.effort, 0); }
      assert.equal(menu.environment, true); assert.ok(menu.top >= 0 && menu.bottom <= menu.viewport, 'Mode panel stays in viewport'); report.checks.push(menu); await shot(`mode-${width}`);
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' }); await sleep(100);
    }
    await run('document.querySelector(".effort-slider button").click()'); await sleep(150);
    assert.ok(await run('!!document.querySelector("[data-effort-popover] input[type=range]")'));
    await run('document.querySelector(".effort-slider button").click()');
    await run('document.querySelector("button[aria-haspopup=listbox]").click()'); await sleep(150);
    assert.ok(await run('document.querySelectorAll("[role=option]").length > 1'));
    await run('document.querySelector("button[aria-haspopup=listbox]").click()');
    report.checks.push({ composerModelAndEffort: true });
    report.hidden = !win.isVisible(); report.bounds = win.getBounds(); assert.ok(report.hidden);
    if (process.env.NEKKO_TEST_HOLD) { win.setContentSize(1100, 800); await sleep(300); console.log('Evidence ready for capture'); await sleep(90000); }
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2)); win.destroy(); app.exit(report.errors.length ? 1 : 0);
});
