// The chat's secret box (#2594): the real ChatPane in a hidden, off-screen,
// non-focusable window with the network blocked. Launch with
//   NEKKO_LAYOUT_FIXTURE=secret-box-fixture.tsx NEKKO_LAYOUT_SANDBOX=secret-box-sandbox.cjs
//   node apps/desktop/scripts/layout-evidence-integration.cjs
// NEKKO_SECRET_BASELINE=1 (with NEKKO_TEST_SOURCE=<main checkout>) records the
// same chat on the unchanged renderer without asserting.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch with layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const baseline = process.env.NEKKO_SECRET_BASELINE === '1';
const VALUE = 'npm_fixtureTokenValue0123456789';
const report = { captures: [], checks: [], errors: [] };
const sleep = ms => new Promise(r => setTimeout(r, ms));
// JSON for splicing into executeJavaScript, with script-breaking characters escaped.
const js = v => JSON.stringify(v).replace(/[<>/\u2028\u2029]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ title: 'Nekko secret box verification (isolated)', width: 1100, height: 820, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('Window took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const check = async (name, expression) => { const value = await run(expression); report.checks.push({ name, value }); if (!baseline && !value) throw Error(name); };
  const frames = [];
  const shot = async name => { const png = (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG(); fs.writeFileSync(path.join(out, name + '.png'), png); report.captures.push(name + '.png'); return png; };
  const cdp = async (method, params) => { if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3'); return win.webContents.debugger.sendCommand(method, params); };
  const point = async selector => run(`(() => { const e = document.querySelector(${js(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  const click = async selector => {
    const p = await point(selector);
    if (!p) throw Error(`Missing ${selector}`);
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...p });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...p });
    await sleep(150);
  };
  const load = async theme => {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 100 && !(await run('!!window.layoutFixture && !!window.secretBoxFixture')); i++) await sleep(100);
    await sleep(300);
    await run(`document.documentElement.dataset.theme=${js(theme)}`);
    await run('secretBoxFixture.show()');
    await sleep(900);
  };
  try {
    for (const width of [1100, 390]) for (const theme of ['dark', 'light']) {
      win.setContentSize(width, 820);
      await load(theme);
      await shot(`secret-${width}-${theme}`);
      if (baseline) continue;
      await check(`box shows the name ${width} ${theme}`, `!!document.querySelector('[data-secret-box]') && document.querySelector('[data-secret-box]').innerText.includes('NPM_TOKEN')`);
      await check(`field is masked ${width} ${theme}`, `document.querySelector('[data-secret-box] input').type === 'password'`);
      await check(`status says what it waits for ${width} ${theme}`, `document.body.innerText.includes('Waiting for NPM_TOKEN')`);
      await check(`no horizontal overflow ${width} ${theme}`, `(() => { const r = document.querySelector('[data-secret-box]').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })()`);
      // Type the value as a user would (renderer input, not OS input).
      const record = width === 1100 && theme === 'dark';
      if (record) frames.push(await shot('frame-0'));
      await click('[data-secret-box] input');
      await cdp('Input.insertText', { text: VALUE });
      await sleep(150);
      await shot(`secret-typed-${width}-${theme}`);
      if (record) frames.push(await shot('frame-1'));
      await check(`typed value never in the page text ${width} ${theme}`, `!document.body.innerText.includes(${js(VALUE)})`);
      await click('[data-secret-show]');
      if (record) frames.push(await shot('frame-2'));
      await check(`Show reveals it ${width} ${theme}`, `document.querySelector('[data-secret-box] input').type === 'text'`);
      await click('[data-secret-show]');
      await click('[data-secret-provide]');
      await sleep(500);
      if (record) { frames.push(await shot('frame-3')); await sleep(300); frames.push(await shot('frame-4')); }
      await shot(`secret-provided-${width}-${theme}`);
      await check(`the value reached the engine once ${width} ${theme}`, `secretBoxFixture.provided.length === 1 && secretBoxFixture.provided[0] === ${js(VALUE)}`);
      await check(`the box is gone ${width} ${theme}`, `!document.querySelector('[data-secret-box]')`);
      await check(`no trace of the value on screen ${width} ${theme}`, `!document.body.innerHTML.includes(${js(VALUE)})`);
    }
    if (!baseline && frames.length) {
      const file = path.join(out, 'secret-box.gif');
      require('./evidence-gif.cjs')(file, frames, 90);
      report.captures.push('secret-box.gif');
    }
  } catch (e) { report.errors.push(String(e.stack || e)); }
  for (const f of fs.readdirSync(out)) if (/^frame-\d\.png$/.test(f)) fs.rmSync(path.join(out, f));
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ checks: report.checks.length, failed: report.checks.filter(c => !c.value).map(c => c.name), errors: report.errors }, null, 2));
  app.exit(report.errors.length ? 1 : 0);
});
