const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Use first-workflow-integration.cjs');
const profile = fs.mkdtempSync(path.join(out, 'profile-'));
app.setPath('userData', profile);
app.setPath('sessionData', profile);
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  const report = { checks: [], errors: [], captures: [] };
  session.defaultSession.webRequest.onBeforeRequest((r, done) => done({ cancel: !/^(file:|data:|blob:)/.test(r.url) }));
  session.defaultSession.setPermissionRequestHandler((_c, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1280, height: 900, useContentSize: true, show: false, focusable: false, x: -5000, y: -3000, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('Fixture took focus'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const check = async (name, s) => report.checks.push({ name, passed: !!await run(s) });
  const capture = async name => {
    const file = path.join(out, name + '.png');
    fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG());
    report.captures.push(file);
  };
  try {
    for (const [label, width, height] of [['desktop', 1280, 900], ['phone', 390, 844]]) {
      win.setContentSize(width, height);
      await win.loadFile(path.join(out, 'index.html')); await sleep(800);
      await capture(label + '-start');
      await check(label + ': hidden and nonfocusable', 'true');
      if (process.env.NEKKO_TEST_LABEL !== 'before') {
        await check(label + ': no horizontal overflow', 'document.documentElement.scrollWidth <= innerWidth');
        await run("document.querySelector('[data-workflow-category=shopping] summary').click()"); await sleep(200);
        await capture(label + '-shopping');
        await run("document.querySelector('[data-workflow-example=stock]').click()"); await sleep(200);
        await capture(label + '-personalize');
        await check(label + ': requires a URL', "document.querySelector('[data-workflow-continue]').disabled");
        await run("(()=>{const el=document.querySelector('[data-workflow-detail]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'https://example.com/product');el.dispatchEvent(new Event('input',{bubbles:true}));})()");
        await sleep(150);
        await run("document.querySelector('[data-workflow-continue]').click()"); await sleep(400);
        await capture(label + '-editor');
        await check(label + ': editable prompt carries URL', "document.body.innerText.includes('Create workflow') && [...document.querySelectorAll('textarea')].some(e=>e.value.includes('https://example.com/product'))");
        await check(label + ': nothing created or run', 'window.workflowEvidence.calls.length === 0');
      }
    }
    report.window = { bounds: win.getBounds(), visible: win.isVisible(), focusable: win.isFocusable() };
    if (win.isVisible() || win.isFocusable()) report.errors.push('Unsafe fixture window');
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  win.destroy();
  session.defaultSession.clearStorageData().finally(() => app.quit());
  app.once('will-quit', () => fs.rmSync(profile, { recursive: true, force: true }));
  process.exitCode = report.errors.length || report.checks.some(c => !c.passed) ? 1 : 0;
}).catch(e => { console.error(e); app.exit(1); });
