// Full-App navigation in a hidden, isolated renderer. No host or OS input.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const baseline = process.env.NEKKO_BREADCRUMB_BASELINE === '1';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { baseline, captures: [], checks: [], errors: [], geometry: {} };
const baselineReport = process.env.NEKKO_BREADCRUMB_COMPARE ? JSON.parse(fs.readFileSync(process.env.NEKKO_BREADCRUMB_COMPARE, 'utf8')) : null;
const js = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -5000, y: -5000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 500)); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const check = async (name, source) => { const ok = await run(source); report.checks.push({ name, ok }); if (!ok) throw Error(name); };
  const shot = async name => { const f = path.join(out, name + '.png'); fs.writeFileSync(f, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(f); };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 100 && !(await run('!!window.breadcrumbFixtureReady && !!document.querySelector("[data-command-wall]")')); i++) await sleep(100);
    await run("localStorage.setItem('fixture.platform','win32')");
    win.webContents.reload();
    await sleep(1500);
    for (let i = 0; i < 100 && !(await run('!!window.breadcrumbFixtureReady')); i++) await sleep(100);
    await run("layoutFixture.store.setState({ settings: {...layoutFixture.store.getState().settings, experimental: {training:true,design:true,memory:true}, showTips:false} })");
    win.webContents.debugger.attach('1.3');
    for (const [width, height] of [[1440,900],[390,844],[840,720]]) {
      win.setContentSize(width, height);
      await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      for (const view of ['artifacts','skills','training','workflows','design','models','modelserver','connectors','memory','settings']) {
        await run('layoutFixture.store.getState().setView(' + js(view) + ')');
        await sleep(450);
        await shot(view + '-' + width);
        if (view === 'settings') {
          const geometry = await run(
            "(() => { const selectors = ['.settings-panel', '.settings-content', '.settings-page', '[data-settings-group=profile]', '#settings-profile-title']; return selectors.map(s => { const e=document.querySelector(s); const r=e.getBoundingClientRect(); const c=getComputedStyle(e); return {selector:s,x:r.x,y:r.y,width:r.width,height:r.height,padding:c.padding,overflowY:c.overflowY}; }); })()"
          );
          report.geometry[width] = geometry;
          if (baselineReport) {
            const ok = JSON.stringify(geometry) === JSON.stringify(baselineReport.geometry[width]);
            report.checks.push({name: 'settings-' + width + ': unchanged content geometry', ok});
            if (!ok) throw Error('Settings content geometry changed at ' + width);
          }
        }
        if (!baseline && view !== 'settings') {
          await check(view + '-' + width + ': no breadcrumb outside Settings', '!document.querySelector("[data-agents-breadcrumb]")');
        }
        if (!baseline && view === 'settings') {
          await check(view + '-' + width + ': breadcrumb visible', '(() => { const e=document.querySelector("[data-agents-breadcrumb]"); if(!e)return false; const r=e.getBoundingClientRect(); return r.width>0 && r.top>=0 && r.right<=innerWidth + 1; })()');
          await check(view + '-' + width + ': one return control', 'document.querySelectorAll("[data-back-to-agents]").length === 1');
        }
        if (!baseline && view === 'settings') {
          await check('breadcrumb lives in Settings rail', '!!document.querySelector(".settings-rail [data-agents-breadcrumb]")');
          const stateBefore = await run('JSON.stringify({ active:layoutFixture.store.getState().activeSessionId, layout:layoutFixture.store.getState().wallLayout })');
          await run('document.querySelector("[data-back-to-agents]").focus()');
          await check('keyboard focus on return control', 'document.activeElement.matches("[data-back-to-agents]")');
          await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
          await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
          await sleep(150);
          const stateAfter = await run('JSON.stringify({ active:layoutFixture.store.getState().activeSessionId, layout:layoutFixture.store.getState().wallLayout })');
          report.checks.push({ name: view + '-' + width + ': preserves active chat and wall layout', ok: stateBefore === stateAfter });
          await check(view + '-' + width + ': returns to Agents', 'layoutFixture.store.getState().view === "command" && !document.querySelector("[data-agents-breadcrumb]")');
        }
      }
    }
    report.background = { visible: win.isVisible(), focusable: win.isFocusable(), focused: win.isFocused(), bounds: win.getBounds() };
    if (report.background.visible || report.background.focused || report.background.focusable) throw Error('unsafe window');
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.errors.length || report.checks.some(c => !c.ok) ? 1 : 0);
});
