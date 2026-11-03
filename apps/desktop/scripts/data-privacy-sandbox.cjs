// Hidden, isolated evidence for Settings > Data & privacy (Delete everything)
// and the Nekko Cloud account row in Settings > Sync. Never contacts a host.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
// Escape JSON literals before embedding them in renderer JavaScript.
const js = (v) => JSON.stringify(v).replace(/[<>/\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], checks: [], errors: [] };
const status = { signedIn: true, account: { email: 'sam@example.com', plan: 'pro', canSync: true }, oauthPending: false, keysStoredIn: 'macOS Keychain', sync: { phase: 'off', enabled: false, includeLocalOnly: false, recoveryConfirmed: false, keyEpoch: null, lastSyncAt: null, error: null, progress: null, chats: 0, pushed: 0, pulled: 0, skipped: {}, fingerprint: null, joinCode: null, devices: [], usage: null } };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1200, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') console.error(e.message.slice(0, 500)); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const shot = async name => { const f = path.join(out, `${name}.png`); fs.writeFileSync(f, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(f); };
  const check = async (name, expression) => { const ok = await run(expression); report.checks.push({ name, ok }); if (!ok) throw Error(name); };
  const button = text => `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${js(text)})`;
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 100 && !(await run('!!window.layoutFixture')); i++) await sleep(100);
    await run(`(() => { const f = layoutFixture; const s = ${js(status)};
      f.bridge.cloudStatus = async () => s; f.bridge.cloudRefresh = async () => s;
      f.bridge.wipeAllData = async (o) => { window.wiped = o ?? {}; return f.store.getState().settings; };
      f.bridge.cloudDeleteAccount = async () => { window.accountDeleted = true; return { ...s, signedIn: false, account: null, sync: { ...s.sync, phase: 'signed-out' } }; };
      f.store.setState({ view: 'settings' }); })()`);
    await sleep(1200);
    const toData = `(() => { const b = ${button('Delete everything')}; b.closest('section').scrollIntoView({ block: 'start' }); })()`;
    await run(toData); await sleep(200);
    await shot('data-privacy');
    if (await run('typeof window.confirm === "function" && !!' + button('Delete everything') + '.dataset.wipe')) {
      await run(`${button('Delete everything')}.click()`); await sleep(200);
      await shot('wipe-dialog');
      await check('dialog lists sign-ins and logs', "document.querySelector('[role=dialog]').textContent.includes('Sign-ins') && document.querySelector('[role=dialog]').textContent.includes('Logs')");
      await check('nothing deleted before confirming', '!window.wiped');
      await run("document.querySelector('[data-wipe-models]').click()"); await sleep(100);
      await shot('wipe-dialog-models');
      await run("document.querySelector('[data-wipe-confirm]').click()"); await sleep(300);
      await check('models choice sent', 'window.wiped && window.wiped.models === true');
    }
    await run("document.querySelector('#sync').scrollIntoView({ block: 'start' })"); await sleep(300);
    await shot('cloud-account');
    if (await run('!!document.querySelector("[data-cloud-delete-account]")')) {
      await run("document.querySelector('[data-cloud-delete-account]').click()"); await sleep(200);
      await shot('cloud-delete-dialog');
      await check('account not deleted before confirming', '!window.accountDeleted');
      await check('confirm disabled until the email is typed', "document.querySelector('[data-cloud-delete-confirm]').disabled");
      await run(`(() => { const e = document.querySelector('[data-cloud-delete-email]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, 'sam@example.com'); e.dispatchEvent(new Event('input', { bubbles: true })); })()`); await sleep(100);
      await shot('cloud-delete-dialog-ready');
      await run("document.querySelector('[data-cloud-delete-confirm]').click()"); await sleep(400);
      await check('account delete called', 'window.accountDeleted === true');
      await check('signed out after delete', "!!document.querySelector('[data-testid=sync-sign-in]')");
    }
    report.bounds = win.getBounds(); report.visible = win.isVisible();
    if (report.visible) throw Error('fixture became visible');
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.errors.length ? 1 : 0);
});
