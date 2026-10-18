const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_COMPONENT_OUT;
if (!out) throw Error('Use fresh-pages-integration.cjs');
const base = Boolean(process.env.NEKKO_TEST_REVISION);
const dir = path.join(out, base ? 'before' : 'after');
fs.mkdirSync(dir, { recursive: true });
app.setPath('userData', path.join(dir, 'profile'));
app.setPath('sessionData', path.join(dir, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_wc, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1280, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -10000, y: -10000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const report = { checks: [], errors: [], captures: [] };
  const run = code => win.webContents.executeJavaScript(code, true);
  const check = async (code, label) => { if (!await run(code)) throw Error(label); report.checks.push(label); };
  const capture = async name => { await sleep(120); const file = path.join(dir, name + '.png'); fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(file); };
  win.on('show', () => report.errors.push('Window became visible'));
  win.on('focus', () => report.errors.push('Window took focus'));
  try {
    await win.loadFile(path.join(out, 'index.html')); await sleep(500);
    for (const theme of ['light', 'dark']) for (const [width, height, size] of [[1280, 900, 'wide'], [460, 1000, 'narrow']]) {
      win.setContentSize(width, height);
      for (const view of ['settings', 'modelserver']) {
        await run(`window.__fixture.show('${view}');window.__fixture.theme('${theme}')`); await sleep(350);
        await check(`document.body.textContent.includes('${view === 'settings' ? 'Appearance' : 'Model server'}')`, `Fresh ${view} renders ${theme}/${size}`);
        await check(`document.documentElement.dataset.theme==='${theme}'`, 'Requested theme survives settings refresh');
        await check(`document.querySelector('.titlebar h1').textContent==='${view === 'settings' ? 'Settings' : 'Model Server'}'`, 'Header names destination');
        await capture(`${view}-${theme}-${size}`);
      }
    }
    for (const view of ['settings', 'modelserver']) {
      await run(`window.__fixture.show('${view}',true)`); await sleep(350);
      if (!base) {
        await check("document.body.textContent.includes('Could not load')", `${view} failure has recovery UI`);
        await capture(`${view}-failure`);
        await run("window.__fixture.recover();[...document.querySelectorAll('button')].find(b=>b.textContent==='Try again').click()"); await sleep(350);
        await check(`document.body.textContent.includes('${view === 'settings' ? 'Appearance' : 'Model server'}')`, `${view} retry recovers`);
      } else await capture(`${view}-failure`);
    }
    if (!base) {
      await run('window.__fixture.crash()'); await sleep(200);
      await check("document.body.textContent.includes('Section could not be displayed') && !!document.querySelector('#sibling')", 'Render failure isolates section and keeps sibling');
      await capture('render-failure');
      await run("window.__fixture.recover();[...document.querySelectorAll('button')].find(b=>b.textContent==='Try again').click()"); await sleep(200);
      await check("document.body.textContent.includes('Recovered section')", 'Render retry remounts section');
      await run("document.querySelector('#nav-settings').click()"); await sleep(200);
      await check("document.body.textContent.includes('Appearance')", 'Navigation works after render failure');
    }
    report.background = { visible: win.isVisible(), focused: win.isFocused() };
  } catch(e) { report.errors.push(String(e)); }
  finally { fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(report,null,2)); console.log(JSON.stringify(report,null,2)); win.destroy(); app.exit(report.errors.length ? 1 : 0); }
});
