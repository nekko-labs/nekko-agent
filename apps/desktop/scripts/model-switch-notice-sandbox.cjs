const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Run through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { checks: [], captures: [], errors: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1100, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -1800, y: -1200, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('Window took focus'));
  const run = s => win.webContents.executeJavaScript(s, true);
  const wait = async s => { for (let i = 0; i < 80; i++) { if (await run(s)) return; await sleep(100); } throw Error(`Timed out: ${s}`); };
  const check = async (name, s) => { const passed = !!await run(s); report.checks.push({ name, passed }); if (!passed) throw Error(name + ': ' + await run("document.body.innerText")); };
  const shot = async name => { for (let i = 0; i < 3; i++) { win.webContents.invalidate(); await sleep(400); await win.capturePage(undefined, { stayHidden: true }); } const file = path.join(out, name + '.png'); fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(file); };
  const pick = async (id = 'second') => {
    await run("[...document.querySelectorAll('button[aria-haspopup=listbox]')].filter(e=>e.getBoundingClientRect().width>0).at(-1).click()");
    await wait("!!document.querySelector('[role=listbox]')");
    // Only fixed fixture ids enter the script, never external input.
    await run(`[...document.querySelectorAll('[role=listbox] button')].find(e=>e.textContent.includes('${id} model')).click()`);
    await sleep(350);
  };
  const dismiss = () => run("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
  try {
    await win.loadFile(path.join(out, 'index.html'));
    await wait("!!window.noticeFixture && [...document.querySelectorAll('button[aria-haspopup=listbox]')].some(e=>e.getBoundingClientRect().width>0)");
    await sleep(500);
    const changed = process.env.NEKKO_NOTICE_CHANGED === '1';
    for (const width of [1100, 390]) {
      win.setContentSize(width, 900);
      await run('noticeFixture.chat()'); await sleep(500);
      await pick();
      await wait("!!document.querySelector('[role=dialog]')");
      await check('estimate shown ' + width, "document.querySelector('[role=dialog]').textContent.includes('106,143')");
      await shot('notice-' + width);
      await dismiss(); await sleep(150);
      await check('Escape closes notice ' + width, "!document.querySelector('[role=dialog]')");
      await check('focus returns to model picker ' + width, "document.activeElement.matches('button[aria-haspopup=listbox]')");
    }
    win.setContentSize(1100, 900);
    if (changed) {
      await run('noticeFixture.chat()'); await sleep(350); await pick();
      await run("document.querySelector('[role=dialog] input[type=checkbox]').click(); [...document.querySelectorAll('[role=dialog] button')].find(e=>e.textContent==='Got it').click()");
      await wait("!document.querySelector('[role=dialog]')");
      await check('dismissal persisted without losing sibling settings', "noticeFixture.saved().developer.showContextChangeNotice===false && noticeFixture.saved().developer.serverControls===true");
      await pick('first');
      await check('later model change suppressed', "!document.querySelector('[role=dialog]')");
      await run("document.querySelector('.effort-trigger').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))"); await sleep(300);
      await check('effort change saved without notice when disabled', "!document.querySelector('[role=dialog]') && layoutFixture.records[0].effort==='high'");
      await win.reload();
      await wait('!!window.noticeFixture'); await sleep(500); await pick();
      await check('suppression survives reload', "!document.querySelector('[role=dialog]') && noticeFixture.saved().developer.showContextChangeNotice===false");
    }
    for (const width of [1100, 390]) {
      win.setContentSize(width, 900);
      await run('noticeFixture.settings()'); await sleep(500);
      await run("[...document.querySelectorAll('#settings-system h2')].find(e=>e.textContent==='Developer').closest('section').scrollIntoView({block:'start'})");
      await sleep(250);
      await shot('settings-' + width);
    }
    if (changed) {
      await run("document.querySelector('button[aria-label=\"Show model-switch token notice\"]').click()"); await sleep(250);
      await check('Developer toggle restores preference', 'noticeFixture.saved().developer.showContextChangeNotice===true');
      await run('noticeFixture.chat()'); await sleep(400); await pick();
      await check('notice returns after re-enabling', "!!document.querySelector('[role=dialog]')");
      await dismiss(); await sleep(100);
      await run("document.querySelector('.effort-trigger').focus(); document.querySelector('.effort-trigger').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}))"); await sleep(300);
      await check('effort changes show the restored notice', "!!document.querySelector('[role=dialog]') && layoutFixture.records[0].effort==='low'");
      await run("document.querySelector('[role=dialog] button').focus(); document.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true}))");
      await check('Tab wraps into checkbox', "document.activeElement.matches('[role=dialog] input[type=checkbox]')");
      await run("noticeFixture.failSave=true; document.querySelector('[role=dialog] input[type=checkbox]').click(); [...document.querySelectorAll('[role=dialog] button')].find(e=>e.textContent==='Got it').click()");
      await sleep(300);
      await check('save failure keeps notice open and preference enabled', "!!document.querySelector('[role=dialog]') && noticeFixture.saved().developer.showContextChangeNotice===true && document.querySelector('[role=dialog]').textContent.includes('Could not save')");
      await run('noticeFixture.failSave=false'); await dismiss(); await sleep(100);
      await check('Escape with checkbox checked does not save dismissal', 'noticeFixture.saved().developer.showContextChangeNotice===true');
      await check('effort dismissal restores keyboard focus', "document.activeElement.matches('.effort-trigger')");
      await pick();
      await check('unchanged model does not open notice', "!document.querySelector('[role=dialog]')");
      await run('noticeFixture.chat(true)'); await sleep(300); await pick();
      await check('empty chats do not show notice', "!document.querySelector('[role=dialog]')");
      await run('noticeFixture.noEstimate=true; noticeFixture.chat()'); await sleep(350); await pick();
      await check('missing estimate is explicit', "document.querySelector('[role=dialog]').textContent.includes('estimate is unavailable')");
      await check('selection alone sends no model request', '!layoutFixture.lastSend');
    }
    report.bounds = win.getBounds(); report.hidden = !win.isVisible();
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.errors.length ? 1 : 0);
});
