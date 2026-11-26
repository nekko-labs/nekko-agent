// Hidden real-renderer journey with synthetic Cloud status and no external I/O.
// Launch with NEKKO_LAYOUT_SANDBOX=cloud-email-sandbox.cjs via layout-evidence-integration.cjs.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Missing evidence directory');
app.disableHardwareAcceleration();
app.setPath('userData', path.join(out, 'profile'));
const baseline = process.env.NEKKO_CLOUD_EMAIL_BASELINE === '1';
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
  const click = selector => run(`${q(selector)}.click(); 0`);
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
  const email = '#feedback-contact-email';
  const contact = '[data-testid=feedback-include-contact] [role=switch]';
  const openFeedback = async () => {
    await run("window.dispatchEvent(new CustomEvent('nekko:feedback', {detail:'rail'}))");
    const kind = '[data-testid=feedback-kind-improve]';
    await wait(`!!${q(kind)}`);
    await click(kind);
    await wait(`!!${q(email)}`);
  };
  const closeFeedback = async () => {
    await click('[data-testid=feedback-sheet] [aria-label=Close]');
    await wait('!document.querySelector("[data-testid=feedback-sheet]")');
  };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    await wait('!!window.layoutFixture');
    await run(`(() => {
      const f = window.layoutFixture;
      // Hidden compositor frames can hold the feedback entrance at zero opacity.
      const style = document.createElement('style');
      style.textContent = '[data-testid=feedback-fields] { animation: none !important; }';
      document.head.append(style);
      const listeners = new Set();
      const status = email => ({ signedIn: !!email, account: email ? { email, plan:'free', canSync:false } : null, sync:{ phase:email ? 'needs-plan' : 'signed-out', devices:[] } });
      window.cloud = status('cloud@example.com');
      window.setCloud = email => { window.cloud = status(email); listeners.forEach(fn => fn(window.cloud)); };
      window.writes = []; window.joins = []; window.notes = [];
      Object.assign(f.bridge, {
        cloudStatus: async () => window.cloud,
        cloudRefresh: async () => window.cloud,
        orgList: async () => ({ orgs:[], invites:[] }),
        onCloudStatus: fn => { listeners.add(fn); return () => listeners.delete(fn); },
        getSettings: async () => f.store.getState().settings,
        updateSettings: async patch => { window.writes.push(patch); return { ...f.store.getState().settings, ...patch }; },
        updatesJoin: async (...args) => { window.joins.push(args); },
        telemetryStatus: async () => ({ configured: false }),
        engineModels: async () => [],

        getRemoteStatus: async () => ({ enabled:false }),
        feedbackInfo: async () => ({ app:'desktop',version:'0.10.1004',os:'macOS' }),
        feedbackSend: async message => { window.notes.push(message); return { ok:true }; },
      });
      f.store.setState({ settings: { ...f.settings, guardrails:[], hooks:[], mcpServers:[], telemetry:{enabled:false}, voice:{}, userName:'Ada Lovelace', userEmail:'' } });
      f.store.getState().setView('settings');
    })()`);
    await wait('!![...document.querySelectorAll(".settings-nav-item")].find(el => el.textContent.trim() === "Profile")');
    await run('[...document.querySelectorAll(".settings-nav-item")].find(el => el.textContent.trim() === "Profile").click(); 0');
    await wait(`!!${q(profile)}`);
    if (baseline) await check('before: Settings email is blank while signed in', `${q(profile)}.value === ''`);
    else await check('Settings shows signed-in email without a saved email', `${q(profile)}.value === 'cloud@example.com'`);
    for (const [size, width] of [['wide', 1200], ['narrow', 390]]) {
      win.setContentSize(width, 900);
      await sleep(250);
      await shot(`profile-${size}`, profile);
    }
    await openFeedback();
    if (baseline) await check('before: feedback email is blank while signed in', `${q(email)}.value === ''`);
    else await check('feedback shows signed-in email and the checked include switch', `${q(email)}.value === 'cloud@example.com' && ${q(contact)}?.getAttribute('aria-checked') === 'true'`);
    for (const [size, width] of [['wide', 1200], ['narrow', 390]]) {
      win.setContentSize(width, 900);
      await sleep(250);
      await shot(`feedback-${size}`, email);
    }
    await closeFeedback();
    if (!baseline) {
      await run(`${q(profile)}.dispatchEvent(new FocusEvent('focusout', {bubbles:true})); 0`);
      await check('opening and leaving the Cloud prefill makes no writes and never joins updates', '!window.writes.some(p => Object.hasOwn(p, "userEmail")) && !window.joins.length');
      await openFeedback();
      await run("window.setCloud(null)");
      await check('sign-out clears unedited account email in both views', `${q(profile)}.value === '' && ${q(email)}.value === ''`);
      await run("window.setCloud('another@example.com')");
      await check('a different account fills both existing views', `${q(profile)}.value === 'another@example.com' && ${q(email)}.value === 'another@example.com'`);
      await fill(email, 'reply@example.com');
      await run("window.setCloud('cloud@example.com')");
      await check('a feedback edit survives a change in Cloud account', `${q(email)}.value === 'reply@example.com'`);
      await fill('#feedback-summary', 'Useful');
      await fill('#feedback-description', 'The model picker works well.');
      await click(contact);
      await click('[data-testid=feedback-send]');
      await check('switching contact off sends neither the name nor email', 'window.notes.length === 1 && !window.notes[0].includes("Ada") && !window.notes[0].includes("example.com")');
      await closeFeedback();
      await openFeedback();
      await fill('#feedback-summary', 'Another note');
      await fill('#feedback-description', 'A short description.');
      await click('[data-testid=feedback-send]');
      await check('leaving contact on sends the displayed Cloud address with the note', 'window.notes.length === 2 && window.notes[1].includes("cloud@example.com")');
      await closeFeedback();
      await run("layoutFixture.store.setState(s => ({settings:{...s.settings,userEmail:'local@example.com'}}))");
      await openFeedback();
      await check('a saved local address takes priority in both views', `${q(profile)}.value === 'local@example.com' && ${q(email)}.value === 'local@example.com'`);
      await closeFeedback();
      await fill(profile, 'updates@example.com');
      await run(`${q(profile)}.dispatchEvent(new FocusEvent('focusout', {bubbles:true})); 0`);
      await check('explicitly saving a different update address still joins once', `layoutFixture.store.getState().settings.userEmail === 'updates@example.com' && window.joins.length === 1 && window.joins[0][0] === 'updates@example.com'`);
      await fill(profile, '');
      await run(`${q(profile)}.dispatchEvent(new FocusEvent('focusout', {bubbles:true})); 0`);
      await check('removing the saved address restores the Cloud fallback without joining', `${q(profile)}.value === 'cloud@example.com' && layoutFixture.store.getState().settings.userEmail === '' && window.joins.length === 1`);
    }
  } catch (e) { report.errors.push(String(e.stack || e)); }
  report.hidden = !win.isVisible();
  report.focusable = win.isFocusable();
  report.bounds = win.getBounds();
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.errors.length || report.captures.length !== 4 || !report.hidden || report.focusable ? 1 : 0);
});
