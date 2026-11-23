// Dropdown caret and one-line model chip evidence, hidden and off-screen.
// Wall composers (default fixture): the model name stays on one line in a narrow window.
//   NEKKO_LAYOUT_SANDBOX=select-caret-sandbox.cjs node apps/desktop/scripts/layout-evidence-integration.cjs
// Settings (NEKKO_LAYOUT_FIXTURE=settings-customize-fixture.tsx): close-ups of native selects.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
app.disableHardwareAcceleration();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const js = v => JSON.stringify(v).replace(/[<>/\u2028\u2029]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const report = { checks: {}, captures: [], errors: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1100, height: 800, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -10000, y: -10000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const run = code => win.webContents.executeJavaScript(code, true);
  const crop = async (name, selector, pad = 16) => {
    const r = await run(`(() => { const e = document.querySelector(${js(selector)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: Math.max(0, Math.round(b.x - ${pad})), y: Math.max(0, Math.round(b.y - ${pad})), width: Math.round(b.width + ${pad * 2}), height: Math.round(b.height + ${pad * 2}) }; })()`);
    if (!r) { report.errors.push('missing ' + selector); return; }
    await sleep(300);
    const file = path.join(out, name + '.png');
    fs.writeFileSync(file, (await win.capturePage(r, { stayHidden: true })).toPNG());
    report.captures.push(file);
  };
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 200)); });
  win.on('show', () => report.errors.push('Window became visible'));
  win.on('focus', () => report.errors.push('Window took focus'));
  try {
    await win.loadURL('about:blank');
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Page.enable');
    await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('nekko.commandWall', JSON.stringify({root:{id:'s1',dir:'row',children:[{id:'a-pane',kind:'chat',refId:'a'},{id:'s2',dir:'col',children:[{id:'b-pane',kind:'chat',refId:'b'},{id:'c-pane',kind:'chat',refId:'c'}],sizes:[0.5,0.5]}],sizes:[0.6,0.4]},hero:'a',watermark:1,autoAdd:false,layout:{mode:'grid'},dock:{show:false},agentPanel:{show:false},zones:true,zonesIntro:true,activeZone:'a-pane'}));` });
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 80 && !await run('!!window.layoutFixture || !!document.querySelector(".settings-nav")'); i++) await sleep(100);
    await sleep(1200);
    if (await run('!!window.layoutFixture')) {
      // The real name from the report, so a squeezed bar has something to wrap.
      await run(`(() => { const st = layoutFixture.store; st.setState({ models: st.getState().models.map(m => ({ ...m, name: 'Claude Opus 5.5' })) }); })()`);
      for (const width of [1100, 480, 400]) {
        win.setContentSize(width, 800);
        await sleep(600);
        await crop(`wall-foot-${width}`, '.composer-bar', 4);
      }
      // One line: the name is no taller than the chip's own line height.
      report.checks.modelNameOneLine = await run(`[...document.querySelectorAll('[data-model-chip-name]')].map(e => { const lh = parseFloat(getComputedStyle(e).lineHeight); return e.getBoundingClientRect().height <= lh * 1.2; })`);
    } else {
      await run(`window.settingsFixture.openSettingsGroup(document.querySelector('#settings-work-profile').closest('[data-settings-group]').dataset.settingsGroup)`);
      await sleep(800);
      report.checks.selects = await run(`document.querySelectorAll('select').length`);
      await crop('settings-work-profile', '#settings-work-profile');
      // The caret sits inside the field: its right inset matches the text's left inset.
      report.checks.caret = await run(`(() => { const s = getComputedStyle(document.querySelector('#settings-work-profile')); return { appearance: s.appearance, paddingRight: s.paddingRight, image: s.backgroundImage.slice(0, 30), position: s.backgroundPosition }; })()`);
      const groups = await run(`JSON.stringify([...document.querySelectorAll('[data-settings-group]')].map(g => g.dataset.settingsGroup))`);
      let n = 0;
      for (const g of JSON.parse(groups)) {
        await run(`window.settingsFixture.openSettingsGroup(${js(g)})`);
        await sleep(300);
        if (await run(`!!document.querySelector('#settings-${g} select')`)) { await crop(`select-${g}`, `#settings-${g} select`); if (++n >= 3) break; }
      }
    }
  } catch (e) {
    report.errors.push(String(e && e.stack || e));
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ checks: report.checks, errors: report.errors.slice(0, 5), captures: report.captures.length }));
    app.exit(process.exitCode || 0);
  }
});
