// Isolated full-app evidence. Never connects to a real host or shows a window.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Use layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((r, done) => done({ cancel: !/^(file:|data:|blob:)/.test(r.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1280, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -5000, y: -5000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const report = { errors: [], captures: [] };
  win.on('focus', () => report.errors.push('took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = code => win.webContents.executeJavaScript(code, true);
  const shot = async name => { await sleep(600); fs.writeFileSync(path.join(out, name + '.png'), (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(name); };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let n = 0; n < 50 && !(await run("!!document.querySelector('[aria-label=\"Agent panel view options\"]')")); n++) await sleep(200);
    await sleep(600);
    await run("document.querySelector('.zones-intro button[aria-label=\"Close\"]')?.click()");
    await sleep(600);
    await run("document.querySelector('[data-first-prompt-intro-skip]')?.click()");
    await sleep(300);
    if (await run("!!document.querySelector('[role=dialog]')")) throw new Error('Unexpected intro dialog blocks the baseline surface');
    await shot('agents');
    await run("document.querySelector('[aria-label=\"Agent panel view options\"]').click()");
    await shot('view-options');
    const customize = await run("[...document.querySelectorAll('button')].find(b => b.textContent === 'Customize…')?.textContent");
    if (customize) {
      await run("[...document.querySelectorAll('button')].find(b => b.textContent === 'Customize…').click()");
      await shot('experience');
      await run("document.querySelector('[aria-label=\"Detailed: every control\"]').click()");
      report.detailedSaved = await run("localStorage.getItem('nekko.chatMode') === 'expert'");
      await shot('experience-detailed');
      await run("document.querySelector('[aria-label=\"Agent tone\"]').value = 'Concise'; document.querySelector('[aria-label=\"Agent tone\"]').dispatchEvent(new Event('change', {bubbles:true}))");
      await sleep(300);
      report.toneSaved = await run("layoutFixture.store.getState().settings.systemInstructions?.includes('<nekko-tone>')");
      if (!report.detailedSaved || !report.toneSaved) throw new Error('Mode/tone persistence failed');
      for (const tab of ['Connectors', 'Skills', 'Experience']) {
        await run(`document.getElementById('customize-${tab}').click()`);
        await shot(`tab-${tab.toLowerCase()}`);
        if (!(await run(`document.getElementById('customize-${tab}').getAttribute('aria-selected') === 'true'`))) throw new Error(`Tab ${tab} did not activate`);
      }
    }
    report.hidden = !win.isVisible();
    report.text = await run('document.body.innerText');
  } catch (e) { report.errors.push(String(e.stack || e)); process.exitCode = 1; }
  if (report.errors.length || !report.hidden) process.exitCode = 1;
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(process.exitCode || 0);
});
