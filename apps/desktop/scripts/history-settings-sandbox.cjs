// Hidden, isolated full-App history Settings evidence and interaction checks.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], checks: [], errors: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1200, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') console.error(e.message.slice(0, 500)); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const shot = async name => { const f = path.join(out, `${name}.png`); fs.writeFileSync(f, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(f); };
  const check = async (name, expression) => { const ok = await run(expression); report.checks.push({ name, ok }); if (!ok) throw Error(name); };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 100 && !(await run('!!window.layoutFixture')); i++) await sleep(100);
    await run(`(() => { const f = layoutFixture; f.bridge.getRemoteStatus = async () => ({ enabled: false }); f.bridge.getHistoryUsage = async () => ({ bytes: 1250000000, count: 42 }); f.bridge.clearHistory = async range => { window.historyRange = range; return 3; }; f.store.setState({ view: 'settings' }); })()`);
    await sleep(1200);
    const scroll = `(() => { const e = document.querySelector('[data-history-settings]') || document.querySelector('#chat-pane-action').closest('section'); e.scrollIntoView({ block: 'start' }); })()`;
    await run(scroll); await sleep(200);
    await shot('history-desktop');
    if (await run("!!document.querySelector('[data-history-settings]')")) {
      await check('1 GB warning shown', "document.querySelector('[data-history-warning]')?.textContent.includes('Nekko Cloud')");
      await run("document.querySelector('[data-history-clear]').click()"); await sleep(100);
      await shot('history-confirmation');
      await check('does not delete before confirmation', '!window.historyRange');
      await run("document.querySelector('[data-history-cancel]').click()");
      await check('cancel does not delete', '!window.historyRange');
      await run("document.querySelector('[data-history-clear]').click()"); await sleep(100);
      await run("document.querySelector('[data-history-confirm]').click()"); await sleep(300);
      await check('selected range sent', "window.historyRange === 'older-1-month'");
      await check('successful result shown', "document.querySelector('[data-history-settings]').textContent.includes('3 completed chats deleted')");
      await run("document.querySelector('[data-history-sync]').click()"); await sleep(100);
      await check('sync navigation', "document.querySelector('#settings-phone').getBoundingClientRect().top < 300");
      await run(scroll); await sleep(100);
    }
    win.setContentSize(390, 844); await sleep(300); await run(scroll); await sleep(100);
    await shot('history-mobile');
    if (await run("!!document.querySelector('[data-history-settings]')")) {
      for (const range of ['today', 'last-week', 'older-2-weeks', 'older-1-month', 'older-6-months']) {
        await run(`(() => { const e = document.querySelector('#history-range'); const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; setter.call(e, ${JSON.stringify(range)}); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        await sleep(50); await run("document.querySelector('[data-history-clear]').click()"); await sleep(50);
        await run("document.querySelector('[data-history-confirm]').click()"); await sleep(100);
        await check('range ' + range, `window.historyRange === ${JSON.stringify(range)}`);
      }
      await run("layoutFixture.bridge.clearHistory = async () => { throw Error('fixture disk failure'); }; document.querySelector('[data-history-clear]').click()"); await sleep(50);
      await run("document.querySelector('[data-history-confirm]').click()"); await sleep(200);
      await check('cleanup failure stays visible after refresh', "document.querySelector('[data-history-settings] [role=alert]')?.textContent.includes('fixture disk failure')");
      await run("document.querySelector('[data-history-cancel]').click()"); await sleep(50);
      await run("layoutFixture.bridge.getHistoryUsage = async () => ({ bytes: 999999999, count: 0 }); [...document.querySelectorAll('button')].find(e => e.textContent === 'Refresh storage').click()"); await sleep(100);
      await check('no warning below threshold', "!document.querySelector('[data-history-warning]')");
      await check('no clear when history empty', "document.querySelector('[data-history-clear]').disabled");
    }
    win.setContentSize(1200, 900);
    await run(`(() => { const f = layoutFixture; const s = f.records[0]; s.archivedAt = Date.now() - 70 * 86400000; f.putCachedSession(s); f.store.setState({ view: 'command', sessions: f.records.map(s => ({...s})) }); })()`);
    await sleep(700);
    await run("[...document.querySelectorAll('button')].find(e => e.textContent.includes('Show completed'))?.click()"); await sleep(200);
    await shot('completed-rows-desktop');
    await run("document.querySelector('[data-completed-row]')?.click()"); await sleep(300);
    await shot('completed-chat-desktop');
    await check('completed chat is read-only', "document.body.textContent.includes('Completed and read-only.')");
    win.setContentSize(390, 844); await sleep(200); await shot('completed-chat-mobile');
    report.bounds = win.getBounds(); report.visible = win.isVisible();
    if (report.visible) throw Error('fixture became visible');
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.errors.length ? 1 : 0);
});
