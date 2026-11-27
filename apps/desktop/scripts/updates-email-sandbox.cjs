// Hidden real-renderer capture of Settings > Profile's update email while it
// has yet to reach Nekko Cloud (#3534), with no external I/O.
// Launch with NEKKO_LAYOUT_SANDBOX=updates-email-sandbox.cjs via layout-evidence-integration.cjs;
// NEKKO_UPDATES_EMAIL_BASELINE=1 with NEKKO_TEST_SOURCE=<main checkout> captures the before.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Missing evidence directory');
app.disableHardwareAcceleration();
app.setPath('userData', path.join(out, 'profile'));
const baseline = process.env.NEKKO_UPDATES_EMAIL_BASELINE === '1';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { baseline, checks: [], errors: [], captures: [] };

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1200, height: 900, x: -5000, y: -5000, show: false, focusable: false, skipTaskbar: true, useContentSize: true, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const run = code => win.webContents.executeJavaScript(code, true);
  const wait = async code => {
    for (let i = 0; i < 80; i++) { if (await run(code)) return; await sleep(100); }
    throw Error(`Timed out: ${code}`);
  };
  const check = async (name, code) => { await wait(code); report.checks.push(name); };
  const q = selector => `document.querySelector(${JSON.stringify(selector)})`;
  const fill = (selector, value) => run(`(() => {
    const el = ${q(selector)};
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const shot = async (key, selector) => {
    await run(`${q(selector)}.scrollIntoView({block:'center'}); document.getAnimations().forEach(a => {try { a.finish(); } catch {}}); 0`);
    await sleep(100);
    const image = await win.capturePage(undefined, { stayHidden: true });
    const file = path.join(out, `${key}.png`);
    fs.writeFileSync(file, image.toPNG());
    report.captures.push(file);
  };
  win.on('focus', () => report.errors.push('Fixture took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 500) + ` @${e.lineNumber}`); });
  const profile = '#settings-user-email';
  const note = '#settings-user-email-note';
  try {
    await win.loadFile(path.join(out, 'index.html'));
    await wait('!!window.layoutFixture');
    await run(`(() => {
      const f = window.layoutFixture;
      window.writes = []; window.joins = [];
      const signedOut = { signedIn: false, account: null, sync: { phase: 'signed-out', devices: [] } };
      Object.assign(f.bridge, {
        cloudStatus: async () => signedOut,
        cloudRefresh: async () => signedOut,
        orgList: async () => ({ orgs: [], invites: [] }),
        onCloudStatus: () => () => {},
        getSettings: async () => f.store.getState().settings,
        updateSettings: async patch => { window.writes.push(patch); return { ...f.store.getState().settings, ...patch }; },
        updatesJoin: async (...args) => { window.joins.push(args); },
        telemetryStatus: async () => ({ configured: false }),
        engineModels: async () => [],
        getRemoteStatus: async () => ({ enabled: false }),
      });
      // Saved while offline: the engine kept it pending.
      f.store.setState({ settings: { ...f.settings, guardrails: [], hooks: [], mcpServers: [], telemetry: { enabled: false }, voice: {}, userName: 'Ada Lovelace', userEmail: 'ada@example.com', userEmailPending: 'ada@example.com' } });
      f.store.getState().setView('settings');
    })()`);
    await wait('!![...document.querySelectorAll(".settings-nav-item")].find(el => el.textContent.trim() === "Profile")');
    await run('[...document.querySelectorAll(".settings-nav-item")].find(el => el.textContent.trim() === "Profile").click(); 0');
    await wait(`!!${q(profile)}`);
    if (baseline) await check('before: an unsent email looks the same as a sent one', `${q(note)}.textContent.includes('At most one email a month')`);
    else await check('an unsent email says it has not reached Nekko Cloud yet', `${q(note)}.textContent.includes("hasn’t reached Nekko Cloud yet") || ${q(note)}.textContent.includes("hasn't reached Nekko Cloud yet")`);
    for (const [size, width] of [['wide', 1200], ['narrow', 390]]) {
      win.setContentSize(width, 900);
      await sleep(250);
      await shot(`unsent-${size}`, profile);
    }
    if (!baseline) {
      await run(`${q(profile)}.dispatchEvent(new FocusEvent('focusout', {bubbles:true})); 0`);
      await check('leaving the field untouched sends nothing', '!window.joins.length');
      // Retyped: an email input trims spaces, so only a real edit fires a change.
      await fill(profile, 'ada@example.co');
      await fill(profile, 'ada@example.com');
      await run(`${q(profile)}.dispatchEvent(new FocusEvent('focusout', {bubbles:true})); 0`);
      await check('saving the same unsent address again sends it at once', `window.joins.length === 1 && window.joins[0][0] === 'ada@example.com'`);
      await fill(profile, '');
      await run(`${q(profile)}.dispatchEvent(new FocusEvent('focusout', {bubbles:true})); 0`);
      await check('clearing says to unsubscribe from an email and drops the pending address', `${q(note)}.textContent.includes('use the unsubscribe link') && window.writes.some(p => p.userEmail === '' && p.userEmailPending === null) && window.joins.length === 1`);
      win.setContentSize(1200, 900);
      await sleep(250);
      await shot('cleared-wide', profile);
    }
  } catch (e) {
    report.errors.push(String(e.stack || e));
    report.state = await run(`JSON.stringify({ writes: window.writes, joins: window.joins, value: ${q(profile)}?.value, note: ${q(note)}?.textContent, settings: { userEmail: layoutFixture.store.getState().settings.userEmail, userEmailPending: layoutFixture.store.getState().settings.userEmailPending } })`).catch(String);
  }
  report.hidden = !win.isVisible();
  report.focusable = win.isFocusable();
  report.bounds = win.getBounds();
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.errors.length || report.captures.length !== (baseline ? 2 : 3) || !report.hidden || report.focusable ? 1 : 0);
});
