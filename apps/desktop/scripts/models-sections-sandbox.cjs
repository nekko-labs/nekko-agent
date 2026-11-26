// Captures the Models page's local section and checks System models and the
// model server start folded. Real Electron renderer, hidden and off-screen,
// isolated from the user profile, engine and network.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
const baseline = process.env.NEKKO_TEST_LABEL === 'models-sections-before';
app.setPath('userData', fs.mkdtempSync(path.join(out, 'profile-')));
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  const report = { captures: [], checks: [], errors: [] };
  session.defaultSession.webRequest.onBeforeRequest((req, done) => done({ cancel: !/^(file:|data:|blob:)/.test(req.url) }));
  session.defaultSession.setPermissionRequestHandler((_c, _p, done) => done(false));
  const x = Math.min(...screen.getAllDisplays().map(d => d.bounds.x));
  const y = Math.min(...screen.getAllDisplays().map(d => d.bounds.y));
  const win = new BrowserWindow({ width: 1280, height: 1100, useContentSize: true, show: false, paintWhenInitiallyHidden: true, focusable: false, skipTaskbar: true, x: x - 3000, y: y - 1600, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = source => win.webContents.executeJavaScript(source);
  const wait = async (source) => { for (let i = 0; i < 80; i++) { if (await run(source)) return; await sleep(100); } throw Error(`Timed out: ${source}`); };
  const capture = async (name, width, height, theme) => {
    win.setContentSize(width, height);
    await run(`fixture.theme('${theme}')`);
    await sleep(450);
    await run(`(() => { const w = document.querySelector('.models-workspace'); const t = document.querySelector('[data-models-section=local]'); w.scrollTo({ top: w.scrollTop + t.getBoundingClientRect().top - w.getBoundingClientRect().top, behavior: 'instant' }); })()`);
    await sleep(450);
    const file = path.join(out, `${name}.png`);
    fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG());
    report.captures.push(file);
  };
  const check = async (name, source) => { await wait(source); report.checks.push(name); };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    await wait("!!document.querySelector('[data-model-family=gemma4e4b]')");
    for (const [name, w, h, theme] of [['desktop-dark', 1280, 1100, 'dark'], ['narrow-dark', 390, 1100, 'dark']]) await capture(name, w, h, theme);
    if (!baseline) {
      await check('System models starts folded', "!document.querySelector('[data-models-section=system]').open && !document.body.innerText.includes('Apple speech')");
      await check('Model server starts folded', "document.querySelector('[data-model-server] button[aria-expanded]').getAttribute('aria-expanded')==='false' && !document.body.innerText.includes('Loaded models')");
      await check('Serving switch stays visible while folded', "document.body.innerText.includes('Serving')");
      await check('A divider sits above the local library', "getComputedStyle(document.querySelector('[data-models-section=library]')).borderTopStyle==='solid'");
      await run("document.querySelector('[data-models-section=system] summary').click()");
      await check('System models opens', "document.body.innerText.includes('Apple speech')");
      await run("document.querySelector('[data-model-server] button[aria-expanded]').click()");
      await check('Model server opens on Loaded models', "document.body.innerText.includes('Loaded models')");
      await run("document.querySelector('[data-models-section=system]').open=false");
      await run("[...document.querySelectorAll('.models-navigation button')].find(b=>b.textContent==='System models').click()");
      await check('The side menu opens System models', "document.querySelector('[data-models-section=system]').open");
      await sleep(1200);
      await capture('desktop-dark-open', 1280, 1100, 'dark');
    }
  } catch (error) {
    report.errors.push(error.stack || String(error));
  }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.errors.length ? 1 : 0);
});
