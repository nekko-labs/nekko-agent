// Real renderer controls, synthetic bridge, hidden isolated Electron window.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Use layout-evidence-integration.cjs');
const before = process.env.NEKKO_TEST_LABEL === 'before';
const profile = path.join(out, 'profile');
app.setPath('userData', profile);
app.setPath('sessionData', profile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((r, done) => done({ cancel: !/^(file:|data:|blob:)/.test(r.url) }));
  session.defaultSession.setPermissionRequestHandler((_c, _p, done) => done(false));
  const win = new BrowserWindow({ width: 660, height: 880, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -12000, y: -12000, title: 'Claude connections verification (synthetic)', webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  const report = { checks: [], errors: [], background: { visible: win.isVisible(), focusable: win.isFocusable() } };
  win.on('focus', () => report.errors.push('Unexpected window focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = code => win.webContents.executeJavaScript(code, true);
  const check = (name, passed) => { report.checks.push({ name, passed: !!passed }); if (!passed) throw Error(name); };
  const click = async text => { await run(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${js(text)}); if (!b || b.disabled) throw Error('Missing enabled button'); b.click(); })()`); await sleep(200); };
  const select = async id => { await run(`(() => { const s = document.querySelector('[data-claude-connection] select'); s.value = ${js(id)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`); await sleep(250); };
  const shot = async name => fs.writeFileSync(path.join(out, name + '.png'), (await win.capturePage(undefined, { stayHidden: true })).toPNG());
  try {
    await win.loadFile(path.join(out, 'index.html'));
    await sleep(700);
    for (const theme of ['dark', 'light']) {
    await run(`document.documentElement.dataset.theme = ${js(theme)}`);
    for (const [label, width] of [['desktop', 660], ['folded', 360], ['unfolded', 820]]) {
      win.setContentSize(width, 880);
      await sleep(300);
      check(label + ' has no horizontal overflow', await run('document.documentElement.scrollWidth <= innerWidth'));
      await shot('picker-' + theme + '-' + label);
    }
    }
    await run('document.documentElement.dataset.theme = "dark"');
    await run('window.integration.show("popup")');
    win.setContentSize(360, 880);
    await sleep(400);
    check('narrow popup stays in viewport', await run(`(() => { const r = document.querySelector('[aria-label="Model source"]').parentElement.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; })()`));
    await shot('popup-folded');
    await run('window.integration.show("picker")');
    await sleep(300);
    win.setContentSize(660, 880);
    if (!before) {
      await select('work');
      check('connection filter does not mutate chat', await run('window.integration.calls.length === 0'));
      check('organization identity shown', await run('document.body.innerText.includes("Example organization") && document.body.innerText.includes("Team plan")'));
      await shot('picker-work');
      await run(`document.querySelector('[role="option"][title^="Sonnet ·"]').click()`);
      await sleep(200);
      check('subscription model selection uses work provider', await run('window.integration.selection().providerId === "work" && window.integration.selection().modelId === "sonnet"'));
      await select('production');
      check('API filters out subscription aliases', await run('!document.querySelector(\'[role="option"][title^="Opus ·"]\')'));
      check('API workspace shown, secret absent', await run('document.body.innerText.includes("workspace-prod") && !document.body.innerHTML.includes("synthetic-secret-never-render")'));
      await shot('picker-api');
      await run(`document.querySelector('[role="option"]').click()`);
      await sleep(200);
      check('API model uses exact destination ID', await run('window.integration.selection().providerId === "production" && window.integration.selection().modelId === "claude-sonnet-4-6"'));
      await select('sandbox');
      await run(`document.querySelector('[role="option"]').click()`);
      await sleep(200);
      check('second key has independent provider ID', await run('window.integration.selection().providerId === "sandbox"'));
      await select('aws');
      check('empty destination has no fallback model', await run('document.querySelectorAll(\'[role="option"]\').length === 0 && window.integration.selection().providerId === "sandbox"'));
    }
    await run('window.integration.show("subscription")'); await sleep(400);
    await click('+ Another subscription account');
    await run(`(() => { const i = document.querySelector('.claude-another input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'Work'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(700);
    if (!before) {
      check('duplicate folder blocks sign-in', await run('document.body.innerText.includes("already uses this profile") && ![...document.querySelectorAll("button")].some(b => b.textContent.includes("Sign in to Work") && !b.disabled)'));
      check('setup has not launched a terminal', await run('!window.integration.calls.some(c => c.terminal)'));
    }
    await shot('subscription-profile');
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
