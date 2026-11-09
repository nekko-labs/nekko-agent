// Claude setup: profile collision guard, profile-scoped identity reads and
// API connection names. Real renderer controls, synthetic bridge, hidden
// isolated Electron window.
const { app, BrowserWindow, session } = require('electron');
// Capture: NEKKO_LAYOUT_FIXTURE=claude-setup-fixture.tsx NEKKO_LAYOUT_SANDBOX=claude-setup-sandbox.cjs
//   node apps/desktop/scripts/layout-evidence-integration.cjs (NEKKO_TEST_LABEL=before for the base).
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Use layout-evidence-integration.cjs');
const before = process.env.NEKKO_TEST_LABEL === 'before';
const profile = path.join(out, 'profile');
app.disableHardwareAcceleration();
app.setPath('userData', profile);
app.setPath('sessionData', profile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((r, done) => done({ cancel: !/^(file:|data:|blob:)/.test(r.url) }));
  session.defaultSession.setPermissionRequestHandler((_c, _p, done) => done(false));
  const win = new BrowserWindow({ width: 660, height: 880, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -12000, y: -12000, title: 'Claude setup verification (synthetic)', webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  const report = { checks: [], errors: [], background: { visible: win.isVisible(), focusable: win.isFocusable() } };
  win.on('focus', () => report.errors.push('Unexpected window focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = code => win.webContents.executeJavaScript(code, true);
  const check = (name, passed) => { report.checks.push({ name, passed: !!passed }); if (!passed) throw Error(name); };
  const click = async text => { await run(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${js(text)}); if (!b || b.disabled) throw Error('Missing enabled button'); b.click(); })()`); await sleep(200); };
  // A hidden window's capture ignores scroll, so grow it to the whole page for each shot.
  const shot = async name => {
    win.setContentSize(660, Math.min(4000, await run('document.documentElement.scrollHeight')));
    await sleep(300);
    fs.writeFileSync(path.join(out, name + '.png'), (await win.capturePage(undefined, { stayHidden: true })).toPNG());
    win.setContentSize(660, 880);
    await sleep(100);
  };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    await sleep(700);
    await run('window.integration.show("subscription")'); await sleep(400);
    await click('+ Another subscription account');
    await run(`(() => { const i = document.querySelector('.claude-another input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'Work'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(700);
    if (!before) {
      check('duplicate folder blocks sign-in', await run('document.body.innerText.includes("already uses this profile") && ![...document.querySelectorAll("button")].some(b => b.textContent.includes("Sign in to Work") && !b.disabled)'));
      check('setup has not launched a terminal', await run('!window.integration.calls.some(c => c.terminal)'));
    }
    await shot('subscription-profile');
    if (!before) {
      const typeProfile = value => run(`(() => { const i = document.querySelector('.claude-another input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${js(value)}); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await typeProfile('Client A'); await sleep(600);
      check('first named profile identity loaded', await run('document.querySelector(".claude-another").innerText.includes("Previous organization")'));
      await typeProfile('Client B'); await sleep(550);
      check('pending profile never reuses previous identity', await run('!document.querySelector(".claude-another").innerText.includes("Previous organization") && ![...document.querySelectorAll(".claude-another button")].some(b => b.textContent.includes("Use this account"))'));
      await typeProfile(''); await sleep(600);
      check('empty named profile cannot save the usual account', await run('!document.querySelector(".claude-another .claude-verdict")'));
    }
    await run('window.integration.show("api")'); await sleep(400);
    await run(`document.querySelector('[role="radio"][aria-label^="API"]')?.click()`);
    // The radio's name comes from its text, not aria-label.
    await run(`(() => { const b = [...document.querySelectorAll('[role="radio"]')].find(b => b.textContent.includes('API key or cloud')); b?.click(); })()`);
    await sleep(200); await click('Connect: add a key or cloud account');
    await shot('api-setup');
    if (!before) {
      check('connection name visible outside disclosure', await run('!![...document.querySelectorAll("label")].find(l => l.textContent.includes("Connection name") && !l.closest("details"))'));
      await run(`(() => { const labels = [...document.querySelectorAll('label')]; for (const [text, value] of [['Connection name', 'Client B API'], ['API key', 'synthetic-new-key']]) { const input = labels.find(l => l.textContent.includes(text))?.querySelector('input'); if (!input) throw Error('Missing input ' + text); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); } })()`);
      await sleep(200); await click('Connect provider');
      check('saving a named API creates a new provider rather than replacing a key', await run('window.integration.calls.some(c => c.saved?.label === "Client B API" && c.saved.kind === "anthropic" && c.saved.id !== "production" && c.saved.id !== "sandbox")'));
    }
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  win.destroy();
  app.exit(report.errors.length || report.checks.some(c => !c.passed) ? 1 : 0);
});
