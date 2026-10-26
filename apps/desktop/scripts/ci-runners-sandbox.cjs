// Synthetic renderer-only evidence for the CI runners section (T213). No host,
// daemon, GitHub, user profile, OS input or network. The window is created
// hidden and non-focusable and is never shown (on macOS a shown window is moved
// back onto a display), so nothing appears over the user's desktop.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch with ci-runners-integration.cjs');
const dir = path.join(out, 'after');
fs.mkdirSync(dir, { recursive: true });
const profile = fs.mkdtempSync(path.join(dir, 'profile-'));
app.setPath('userData', profile);
app.setPath('sessionData', profile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = v => JSON.stringify(v).replace(/[<>\/\u2028\u2029]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
app.whenReady().then(async () => {
  const report = { revision: 'working-tree', checks: [], errors: [], captures: [], blockedNetwork: [], windowBounds: null };
  session.defaultSession.webRequest.onBeforeRequest((r, done) => {
    const cancel = !/^(file:|data:|blob:)/.test(r.url);
    if (cancel) report.blockedNetwork.push(r.url);
    done({ cancel });
  });
  session.defaultSession.setPermissionRequestHandler((_c, _p, done) => done(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  const win = new BrowserWindow({ width: 1280, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, title: 'Isolated CI runners verification', webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('Fixture took focus'));
  win.on('show', () => report.errors.push('Fixture window was shown'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const check = async (name, source) => { report.checks.push({ name, passed: !!await run(source) }); };
  const capture = async name => {
    const image = await win.capturePage(undefined, { stayHidden: true, stayAwake: false });
    if (image.isEmpty()) throw Error('Empty capture: ' + name);
    const file = path.join(dir, name + '.png');
    fs.writeFileSync(file, image.toPNG()); report.captures.push({ file, size: image.getSize() });
  };
  const click = sel => run(`(()=>{const e=${sel};e&&e.click();return !!e})()`);
  const byText = (tag, text) => `[...document.querySelectorAll(${js(tag)})].find(e=>e.textContent.trim()===${js(text)})`;
  // React tracks input values itself: set through the native setter, then fire input.
  const type = (sel, value) => run(`(()=>{const e=${sel};const p=e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,${js(value)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  const field = label => `[...document.querySelectorAll('[role=dialog] label')].find(l=>l.firstChild&&l.firstChild.textContent===${js(label)}).querySelector('input,textarea')`;
  const open = async (scene, theme) => {
    await run(`integration.show(${js(scene)})`); await sleep(400);
    await run(`document.documentElement.dataset.theme=${js(theme)}`);
    await click(byText('[aria-label=Section] button', 'CI runners')); await sleep(700);
  };
  const scenes = {
    'first-visit': async () => {},
    running: async () => {},
    waiting: async () => {},
    error: async () => {},
    'off-no-vm-support': async () => {},
    'settings-no-vm-support': async () => { await click(`document.querySelector('[aria-label^="Runner settings for"]')`); await sleep(500); },
    unavailable: async () => {},
    'connect-step-3': async () => {
      await click(byText('button', 'Connect GitHub')); await sleep(300);
      await type(field('App ID'), '1048576');
      await type(field('Installation ID'), '58210934');
      await type(field('Private key'), '-----BEGIN RSA PRIVATE KEY-----\nfixture\n-----END RSA PRIVATE KEY-----');
      await click(byText('[role=dialog] button', 'Next')); await sleep(200);
      await type(field('Repo'), 'nekko-labs/nekko-agent');
      await click(`document.querySelector('[role=dialog] input[type=checkbox]')`); await sleep(100);
      await click(byText('[role=dialog] button', 'Next')); await sleep(400);
    },
    settings: async () => { await click(`document.querySelector('[aria-label^="Runner settings for"]')`); await sleep(500); },
    // The sheet is taller than the window: the same sheet scrolled to its end shows Max job time.
    'settings-bottom': async () => {
      await click(`document.querySelector('[aria-label^="Runner settings for"]')`); await sleep(500);
      await run("[...document.querySelectorAll('[role=dialog], [role=dialog] *')].forEach(e=>{e.scrollTop=e.scrollHeight})"); await sleep(200);
    },
    'settings-unsampled': async () => { await click(`document.querySelector('[aria-label^="Runner settings for"]')`); await sleep(500); },
  };
  const checks = {
    'first-visit': [['first-visit card', "document.body.innerText.includes('Use this Mac as a CI runner')"]],
    running: [['running job and waiting slot', "document.body.innerText.includes('ios-native · PR #904') && document.body.innerText.includes('Waiting: you\\'re using the Mac') && document.body.innerText.includes('14 jobs')"]],
    waiting: [['every reason as a sentence', "['This Mac is on battery, below what this mode allows.','This network is not one you trust. Add it in runner settings.','You\\'re using the Mac.'].every(s=>document.body.innerText.includes(s))"],
      ['memory-bound slot greyed with its sentence', "document.body.innerText.includes('Not available: Not enough runner memory for another VM.')"]],
    error: [['missing image error', "document.body.innerText.includes('No VM image yet.')"]],
    'off-no-vm-support': [['off runner shows the daemon error', "document.querySelector('[role=alert]')?.textContent.includes('VM support unavailable') && document.body.innerText.includes('Unavailable')"]],
    'settings-no-vm-support': [['the sheet says why instead of waiting', "document.querySelector('[role=dialog]').innerText.includes('VM support unavailable') && !document.body.innerText.includes('first reading')"]],
    unavailable: [['one plain sentence', "document.body.innerText.includes('They need a Mac with Apple silicon') && !document.body.innerText.includes('unknown channel') && !document.querySelector('[data-runner-card]')"]],
    'connect-step-3': [['connect step 3 with public callout', "document.querySelector('[aria-current=step]')?.textContent.includes('How this Mac helps') && document.body.innerText.includes('may be public')"]],
    settings: [['exact mode labels present', "[\"Do not disturb: Only run when I'm idle\",'Balanced: in the background','Runner first','System default','While a runner is active','Always','Let jobs use the internet directly while a VPN is on'].every(s=>document.querySelector('[role=dialog]').innerText.includes(s))"],
      ['recommendation shown', "document.body.innerText.includes('Recommended: 20 GB for this Mac')"]],
    'settings-bottom': [['Max job time and Save in view', "(()=>{const v=e=>{const r=e.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight};const m=[...document.querySelectorAll('[role=dialog] p')].find(e=>e.textContent==='Max job time');const s=[...document.querySelectorAll('[role=dialog] button')].find(e=>e.textContent==='Save');return !!m&&!!s&&v(m)&&v(s)})()"]],
    'settings-unsampled': [['waits for the first reading', "document.body.innerText.includes('Waiting for this Mac\\'s first reading.') && !document.body.innerText.includes('Recommended:')"]],
  };
  try {
    await win.loadFile(path.join(out, 'index.html')); await sleep(1000);
    for (const theme of ['light', 'dark']) {
      for (const [scene, act] of Object.entries(scenes)) {
        await open(scene, theme); await act(); await sleep(300);
        await capture(`ci-runners-${scene}-${theme}`);
        await check(`${theme} ${scene}: no em dash in document text`, "!document.body.innerText.includes('\\u2014')");
        for (const [name, src] of checks[scene]) await check(`${theme} ${scene}: ${name}`, src);
      }
    }
    report.windowBounds = win.getBounds();
    if (win.isVisible()) report.errors.push('Fixture window is visible');
  } catch (e) { report.errors.push(String(e && e.stack || e)); }
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  const failed = report.checks.filter(c => !c.passed);
  console.log(JSON.stringify({ checks: report.checks.length, captures: report.captures.length, failed, errors: report.errors, blockedNetwork: report.blockedNetwork.length, windowBounds: report.windowBounds }, null, 2));
  app.exit(failed.length || report.errors.length ? 1 : 0);
});
