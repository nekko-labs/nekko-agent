// Full-App synthetic evidence: hidden, non-focusable Electron; no host/network access.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Use layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
app.setPath('sessionData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ title: 'Agents sections isolated evidence', width: 1440, height: 900, useContentSize: true, show: false, focusable: false, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const report = { checks: [], errors: [], captures: [], layouts: [] };
  win.on('show', () => report.errors.push('Window shown'));
  win.on('focus', () => report.errors.push('Window focused'));
  const run = code => win.webContents.executeJavaScript(code, true);
  const check = async (code, label) => { if (!await run(code)) throw Error(label); report.checks.push(label); };
  try {
    await win.loadFile(path.join(out, 'index.html')); await sleep(2000);
    await run(`(async () => { const f = window.layoutFixture; const settings = await f.bridge.updateSettings({showTips:false, firstPromptIntroSeen:true}); f.store.setState({settings}); })()`);
    await sleep(500);
    const cdp = win.webContents.debugger; cdp.attach('1.3');
    await cdp.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await run("document.querySelector('.zones-intro button[aria-label=Close]')?.click()");
    for (const theme of ['dark', 'light']) {
      await run(`document.documentElement.dataset.theme = '${theme}'`);
      for (const orientation of ['vertical', 'horizontal']) {
        win.setContentSize(1440, 900); await sleep(300);
        await run(`document.querySelector('button[aria-label="Show agents in a ${orientation === 'vertical' ? 'column' : 'row'}"]')?.click()`); await sleep(400);
        for (const width of [1440, 760]) {
          win.setContentSize(width, 900); await sleep(450);
          await check(`document.querySelector('[data-agent-panel][data-orientation="${orientation}"]') !== null`, `${theme}/${orientation}/${width}: real Agents panel mounted`);
          const layout = await run(`(() => { const groups = [...document.querySelectorAll('.agent-panel-group')]; return groups.map(e => { const s = getComputedStyle(e), r = e.getBoundingClientRect(); return {key:e.dataset.agentGroup, x:r.x, y:r.y, width:r.width, height:r.height, marginTop:s.marginTop, paddingTop:s.paddingTop, paddingLeft:s.paddingLeft, before:getComputedStyle(e, '::before').backgroundColor}; }); })()`);
          report.layouts.push({theme, orientation, width, groups:layout});
          if (!process.env.NEKKO_BEFORE) {
            await check(`(() => { const g = document.querySelectorAll('.agent-panel-group'); return g.length > 1 && getComputedStyle(g[1], '::before').content === '\"\"'; })()`, `${theme}/${orientation}/${width}: divider drawn only between groups`);
            await check(`getComputedStyle(document.querySelector('.agent-panel-group'), '::before').content === 'none'`, `${theme}/${orientation}/${width}: no leading divider`);
          }
          const file = path.join(out, `${theme}-${orientation}-${width}.png`);
          fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(file);
        }
      }
    }
    win.setContentSize(1440, 900);
    await run("document.querySelector('button[aria-label=\"Show agents in a column\"]')?.click()"); await sleep(400);
    const first = '[data-sidebar-group]';
    await run(`document.querySelector('${first}').click()`); await sleep(300);
    await check(`document.querySelector('${first}').getAttribute('aria-expanded') === 'false'`, 'Group still collapses');
    await run(`document.querySelector('${first}').click()`); await sleep(300);
    await check(`document.querySelector('${first}').getAttribute('aria-expanded') === 'true'`, 'Group still expands');
    if (!process.env.NEKKO_BEFORE) {
      await check(`(() => { const e = document.querySelector('button[aria-label="Automations"] svg'); return e?.dataset.gentlefaceIcon === 'bolt' && e.querySelectorAll('[fill="#fbbf24"]').length === 1; })()`, 'Automations uses the gold Gentleface bolt');
    }
    cdp.detach(); report.background = { visible: win.isVisible(), focused: win.isFocused(), bounds: win.getBounds() };
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  win.destroy(); app.exit(report.errors.length ? 1 : 0);
});
