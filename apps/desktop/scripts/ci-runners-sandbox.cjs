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
    await click(byText('[role=dialog] button', 'Cancel')); // the confirmation a cancel scene left open
    await run(`document.documentElement.dataset.theme=${js(theme)}`);
    await click(byText('[aria-label=Section] button', 'CI runners')); await sleep(700);
  };
  const connect = async () => { await click(byText('button', 'Connect GitHub')); await sleep(400); };
  const toSetup = async () => { await click(byText('[role=dialog] button', 'Continue to Mac setup')); await sleep(400); };
  const step2 = async () => { await click(byText('.runner-step button', 'Set up this Mac')); await sleep(300); };
  const details = async () => { await click(byText('[data-runner-card] button', 'Details')); await sleep(300); };
  const finish = async () => { await details(); await run('integration.finishBuild()'); await sleep(300); };
  const forkStep = async () => {
    await connect();
    await click(`[...document.querySelectorAll('[role=dialog] label')].find(l=>l.textContent.includes('Require approval'))`); await sleep(100);
    await toSetup();
  };
  const manual = async () => { await click(byText('[role=dialog] button', 'Use an app I already have')); await sleep(200); };
  const scenes = {
    'first-visit': async () => {},
    running: async () => {},
    waiting: async () => {},
    error: async () => {},
    'off-no-vm-support': async () => {},
    'settings-no-vm-support': async () => { await click(`document.querySelector('[aria-label^="Runner settings for"]')`); await sleep(500); },
    unavailable: async () => {},
    'connect-step-1': async () => { await connect(); await manual(); },
    'connect-step-3': async () => {
      await connect(); await manual();
      await type(field('App ID'), '1048576');
      await type(field('Installation ID'), '58210934');
      await type(field('Private key'), '-----BEGIN RSA PRIVATE KEY-----\nfixture\n-----END RSA PRIVATE KEY-----');
      await click(byText('[role=dialog] button', 'Next')); await sleep(200);
      await type(field('Repo'), 'nekko-labs/nekko-agent');
      await click(`document.querySelector('[role=dialog] input[type=checkbox]')`); await sleep(100);
      await click(byText('[role=dialog] button', 'Next')); await sleep(400);
    },
    'github-account': async () => { await connect(); },
    'github-account-no-gh': async () => { await connect(); },
    'github-free-org': async () => { await connect(); await click(`[...document.querySelectorAll('[role=dialog] label')].find(l=>l.textContent.includes('free-org'))`); await sleep(200); },
    'github-waiting': async () => { await connect(); },
    'github-confirm': async () => { await connect(); },
    'github-handoff': async () => { await connect(); await toSetup(); },
    'github-confirm-public': async () => { await connect(); },
    'github-fork': async () => { await forkStep(); },
    'github-fork-on': async () => { await forkStep(); await click(byText('[role=dialog] button', 'It is on, continue to Mac setup')); await sleep(400); },
    'github-fork-left-off': async () => { await forkStep(); await click(byText('[role=dialog] button', 'Leave it off')); await sleep(400); },
    'first-visit-connected': async () => {},
    'setup-plan': async () => { await step2(); },
    'setup-no-xcode': async () => { await step2(); },
    'setup-download': async () => {},
    'setup-install': async () => { await details(); },
    'setup-waiting': async () => { await details(); },
    'setup-cancel': async () => { await details(); await click(byText('[role=dialog] button', 'Cancel setup')); await sleep(300); },
    'setup-failed': async () => { await details(); },
    'setup-refused-macos': async () => { await details(); },
    'setup-refused-helper': async () => { await details(); },
    'setup-resume': async () => { await click(byText('[data-runner-card] button', 'Resume setup')); await sleep(300); },
    'setup-rebuild': async () => {
      await click(`document.querySelector('[aria-label^="Runner settings for"]')`); await sleep(400);
      await click(byText('[role=dialog] button', 'Rebuild image')); await sleep(400);
    },
    ready: async () => { await finish(); },
    'ready-left-off': async () => { await finish(); },
    'ready-second-runner': async () => { await finish(); },
    'rebuild-cancelled': async () => {
      await details(); await click(byText('[role=dialog] button', 'Cancel setup')); await sleep(300);
      await click(byText('[role=dialog] button', 'Delete')); await sleep(400);
    },
    'connect-busy': async () => {
      await connect(); await click(byText('[role=dialog] button', 'Continue to Mac setup')); await sleep(100);
      await run("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"); await sleep(100);
    },
    'image-retry': async () => { await run('integration.pushRunners()'); await sleep(300); },
    'card-ready': async () => {},
    settings: async () => { await click(`document.querySelector('[aria-label^="Runner settings for"]')`); await sleep(500); },
    // The sheet is taller than the window: the same sheet scrolled to its end shows Max job time.
    'settings-bottom': async () => {
      await click(`document.querySelector('[aria-label^="Runner settings for"]')`); await sleep(500);
      await run("[...document.querySelectorAll('[role=dialog], [role=dialog] *')].forEach(e=>{e.scrollTop=e.scrollHeight})"); await sleep(200);
    },
    'settings-unsampled': async () => { await click(`document.querySelector('[aria-label^="Runner settings for"]')`); await sleep(500); },
  };
  const checks = {
    'first-visit': [['both steps, step 2 waits', "(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent==='After step 1');return document.body.innerText.includes('Use this Mac as a CI runner')&&document.querySelectorAll('.runner-step svg').length===2&&b&&b.disabled})()"]],
    'first-visit-connected': [['step 1 checked, step 2 lit, the card below', "(()=>{const t=document.body.innerText;return t.includes('Connected')&&!t.includes('After step 1')&&!!document.querySelector('[data-runner-card]')&&[...document.querySelectorAll('.runner-step button')].some(e=>e.textContent==='Set up this Mac')})()"],
      ['the off runner reads Off, with no error line', "(()=>{const c=document.querySelector('[data-runner-card]');const leaf=t=>[...c.querySelectorAll('*')].some(e=>!e.children.length&&e.textContent===t);return leaf('Off')&&!leaf('Waiting')&&!c.innerText.includes('No VM image yet.')})()"]],
    running: [['running job and waiting slot', "document.body.innerText.includes('ios-native · PR #904') && document.body.innerText.includes('Waiting: you\\'re using the Mac') && document.body.innerText.includes('14 jobs')"]],
    waiting: [['every reason as a sentence', "['This Mac is on battery, below what this mode allows.','This network is not one you trust. Add it in runner settings.','You\\'re using the Mac.'].every(s=>document.body.innerText.includes(s))"],
      ['memory-bound slot greyed with its sentence', "document.body.innerText.includes('Not available: Not enough runner memory for another VM.')"]],
    error: [['missing image error', "document.body.innerText.includes('No VM image yet.')"]],
    'off-no-vm-support': [['off runner shows the daemon error', "document.querySelector('[role=alert]')?.textContent.includes('VM support unavailable') && document.body.innerText.includes('Unavailable')"]],
    'settings-no-vm-support': [['the sheet says why instead of waiting', "document.querySelector('[role=dialog]').innerText.includes('VM support unavailable') && !document.body.innerText.includes('first reading')"]],
    unavailable: [['one plain sentence', "document.body.innerText.includes('They need a Mac with Apple silicon') && !document.body.innerText.includes('unknown channel') && !document.querySelector('[data-runner-card]')"]],
    'connect-step-1': [['manual step 1 fields', "document.querySelector('[role=dialog]').innerText.includes('Installation ID')"]],
    'connect-step-3': [['connect step 3 with public callout', "document.querySelector('[aria-current=step]')?.textContent.includes('How this Mac helps') && document.body.innerText.includes('may be public')"]],
    'github-account': [['accounts from gh', "['nekko-labs','Organization','Your account','Another account','Continue on GitHub','Use an app I already have'].every(s=>document.querySelector('[role=dialog]').innerText.includes(s))"]],
    'github-account-no-gh': [['one text box', "(()=>{const d=document.querySelector('[role=dialog]').innerText;return d.includes('GitHub account or org')&&!d.includes('Another account')})()"]],
    'github-free-org': [['single repo offer', "document.querySelector('[role=dialog]').innerText.includes('Connect one repo on GitHub')"]],
    'github-waiting': [['waiting on GitHub', "(()=>{const d=document.querySelector('[role=dialog]').innerText;return d.includes('Finish on GitHub')&&d.includes('Open GitHub again')&&d.includes('Done')&&d.includes('Waiting')})()"]],
    'github-confirm': [['repos ticked', "document.querySelectorAll('[role=dialog] input[type=checkbox]:checked').length===3"]],
    'github-handoff': [['Confirm hands to Mac setup, mode only with an image', "(()=>{const d=document.querySelector('[role=dialog]').innerText;return d.includes('Set up this Mac')&&d.includes('Start runner')&&!d.includes('Space needed')})()"]],
    'github-confirm-public': [['public repo blocks Continue', "(()=>{const b=[...document.querySelectorAll('[role=dialog] button')].find(e=>e.textContent==='Continue to Mac setup');return document.querySelector('[role=dialog]').innerText.includes('Public repo.')&&b.disabled})()"]],
    'github-fork': [['fork step keeps the runner off', "document.querySelector('[role=dialog]').innerText.includes('the runner stays off')"]],
    'github-fork-on': [['It is on goes to Mac setup', "document.querySelector('[role=dialog]').innerText.includes('Download and set up')"]],
    'github-fork-left-off': [['Leave it off closes, with step 2 still lit', "!document.querySelector('[role=dialog]')&&document.body.innerText.includes('Connected')&&!document.body.innerText.includes('This Mac is ready')"]],
    'setup-plan': [['frame 5', "['macOS from Apple','iOS simulator from Apple','Xcode 27.2 from this Mac','110 GB of 369 GB free','Do not disturb','Balanced','Runner first','Download and set up'].every(s=>document.querySelector('[role=dialog]').innerText.includes(s))"]],
    'setup-no-xcode': [['macOS only offered', "(()=>{const d=document.querySelector('[role=dialog]').innerText;return d.includes('macOS only')&&!d.includes('Copied in')})()"]],
    'setup-download': [['the card shows the stage and bar', "document.querySelector('[data-runner-card]').innerText.includes('Download macOS: 12.4 of 25.6 GB')&&!document.body.innerText.includes('No VM image yet.')"]],
    'setup-install': [['install percentage', "document.querySelector('[role=dialog]').innerText.includes('48%')&&!!document.querySelector('.runner-bar')"]],
    'setup-waiting': [['the waiting reason shows', "(()=>{const d=document.querySelector('[role=dialog]').innerText;return d.includes('Waiting for a free VM slot')&&!document.querySelector('.runner-bar')})()"]],
    'setup-cancel': [['cancel asks first', "[...document.querySelectorAll('[role=dialog]')].some(d=>d.innerText.includes('What it has built so far is gone'))"]],
    'setup-failed': [['the sentence and Try again', "(()=>{const d=document.querySelector('[role=dialog]').innerText;return d.includes('Free up 42 GB')&&d.includes('Try again')&&d.includes('Show log')})()"]],
    'setup-refused-macos': [['the refusal as written', "(()=>{const d=document.querySelector('[role=dialog]').innerText;return d.includes('Update this Mac to macOS 27 to set it up here.')&&d.includes('Cancel setup')})()"]],
    'setup-refused-helper': [['the refusal as written', "document.querySelector('[role=dialog]').innerText.includes('This copy of Nekko cannot build a VM on its own. Update Nekko, or bring your own image.')"]],
    'setup-resume': [['resume offered', "document.querySelector('[role=dialog]').innerText.includes('Resume setup')"]],
    'setup-rebuild': [['rebuild asks no mode', "(()=>{const d=document.querySelector('[role=dialog]').innerText;return d.includes('Rebuild image')&&!d.includes('Do not disturb')})()"]],
    ready: [['frame 8, exactly two buttons', "(()=>{const d=document.querySelector('[role=dialog]');return d.innerText.includes('This Mac is ready')&&d.querySelectorAll('button').length===2&&!!d.querySelector('.runner-burst')})()"]],
    'ready-left-off': [['never called ready while off', "(()=>{const d=document.querySelector('[role=dialog]');return !d.innerText.includes('This Mac is ready')&&!d.querySelector('.runner-burst')&&d.innerText.includes('The runner is off.')&&d.innerText.includes('outside contributors')})()"]],
    'ready-second-runner': [['a runner the build did not name gets its mode', "(()=>{const d=document.querySelector('[role=dialog]');return d.innerText.includes('Start runner')&&!d.innerText.includes('outside contributors')})()"]],
    'rebuild-cancelled': [['a cancelled rebuild closes, never ready', "!document.querySelector('[role=dialog]')&&!document.body.innerText.includes('This Mac is ready')"]],
    'connect-busy': [['Escape waits for the connect', "[...document.querySelectorAll('[role=dialog]')].some(d=>d.innerText.includes('GitHub is connected'))"]],
    'image-retry': [['the card recovers after a refused first status', "document.querySelector('[data-runner-card]').innerText.includes('Set up this Mac')"]],
    'card-ready': [['workflow action on the card', "document.querySelector('[data-runner-card]').innerText.includes('Connect to a workflow')"]],
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
      // Motion: stepped frames, because a hidden window's timing is not worth trusting for stills.
      const burst = "document.getAnimations().filter(a=>a.effect.target.closest&&a.effect.target.closest('.runner-burst'))";
      await open('ready', theme); await finish();
      await check(`${theme} ready: plays once, about a second`, `(()=>{const a=${burst};return a.length>0&&a.every(x=>{const t=x.effect.getTiming();return t.iterations===1&&t.duration===1100})})()`);
      await run(`${burst}.forEach(a=>a.pause())`);
      for (const ms of [0, 150, 300, 500, 800, 1100]) {
        await run(`${burst}.forEach(a=>{a.currentTime=${ms}})`); await sleep(120);
        await capture(`ci-runners-ready-frame-${String(ms).padStart(4, '0')}-${theme}`);
      }
      await run(`${burst}.forEach(a=>a.play())`); await sleep(1400);
      await check(`${theme} ready: nothing left running`, `${burst}.every(a=>a.playState==='finished')`);
      const cdp = win.webContents.debugger;
      cdp.attach('1.3');
      await cdp.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await open('ready', theme); await finish(); await sleep(200);
      await capture(`ci-runners-ready-reduced-motion-${theme}`);
      await check(`${theme} ready: reduced motion has no animation, final frame`, `(()=>{const b=document.querySelector('.runner-burst .badge');const p=b.querySelector('path');return ${burst}.length===0&&getComputedStyle(b).opacity==='1'&&getComputedStyle(p).strokeDashoffset==='0px'})()`);
      await cdp.sendCommand('Emulation.setEmulatedMedia', { features: [] });
      cdp.detach();
    }
    report.windowBounds = win.getBounds();
    if (win.isVisible()) report.errors.push('Fixture window is visible');
  } catch (e) { report.errors.push(String(e && e.stack || e)); }
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  const failed = report.checks.filter(c => !c.passed);
  console.log(JSON.stringify({ checks: report.checks.length, captures: report.captures.length, failed, errors: report.errors, blockedNetwork: report.blockedNetwork.length, windowBounds: report.windowBounds }, null, 2));
  app.exit(failed.length || report.errors.length ? 1 : 0);
});
