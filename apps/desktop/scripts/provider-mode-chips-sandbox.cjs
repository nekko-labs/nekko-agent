// Hidden real-renderer evidence, with a disposable profile and external requests blocked.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { checks: [], errors: [], captures: [], background: [] };
const js = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const displays = screen.getAllDisplays();
  const win = new BrowserWindow({ width: 1100, height: 1050, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: Math.min(...displays.map(d => d.bounds.x)) - 2000, y: Math.min(...displays.map(d => d.bounds.y)) - 2000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('Window took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = code => win.webContents.executeJavaScript(code, true);
  const check = async (name, code) => { if (!await run(code)) throw Error(name); report.checks.push(name); };
  fs.cpSync(path.join(__dirname, '../src/renderer/public/providers'), path.join(out, 'providers'), { recursive: true });
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 100 && !await run('!!window.modeChipsFixture'); i++) await sleep(100);
    for (const width of [1100, 360, 768]) {
      win.setContentSize(width, 1050);
      for (const group of ['subscriptions', 'api', 'code', 'local']) {
        await run(`modeChipsFixture.show(${js(group)})`);
        await sleep(500);
        await check(`${group} cards mounted at ${width}`, `document.querySelectorAll('[id^="provider-"]').length === ${{ subscriptions: 2, api: 3, code: 2, local: 1 }[group]}`);
        await check(`No horizontal overflow ${group} ${width}`, 'document.documentElement.scrollWidth <= innerWidth');
        if (process.env.NEKKO_EXPECT_MODE_CHIPS === '1') {
          const expected = group === 'subscriptions' ? 'Subscription' : group === 'local' ? null : 'API';
          await check(`Correct ${group} chiplets at ${width}`, `Array.from(document.querySelectorAll('[id^="provider-"]')).every(card => {const badges = Array.from(card.querySelectorAll('[data-provider-billing]')); return ${js(expected)} === null ? badges.length === 0 : badges.length === 1 && badges[0].textContent === ${js(expected)};})`);
        }
        if (group === 'subscriptions' && process.env.NEKKO_EXPECT_MODE_CHIPS === '1') {
          await run("modeChipsFixture.changeClaudeAuth('api_key')"); await sleep(150);
          await check('Claude mode updates to API on focus ' + width, "document.querySelector('#provider-claude-plan [data-provider-billing]')?.textContent === 'API'");
          await run("modeChipsFixture.changeClaudeAuth('signed_out')"); await sleep(150);
          await check('Signed out Claude does not claim a plan ' + width, "!document.querySelector('#provider-claude-plan [data-provider-billing]')");
          await run("modeChipsFixture.changeClaudeAuth('subscription')"); await sleep(150);
        }
        const file = path.join(out, `${group}-${width}.png`);
        fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
        report.captures.push(file);
        report.background.push({ visible: win.isVisible(), focusable: win.isFocusable(), bounds: win.getBounds() });
      }
    }
  } catch (error) { report.errors.push(String(error.stack || error)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  win.destroy();
  app.exit(report.errors.length ? 1 : 0);
});
