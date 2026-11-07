const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], checks: [], errors: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('took focus'));
  const run = s => win.webContents.executeJavaScript(s, true);
  const shot = async name => { const file = path.join(out, name + '.png'); fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(file); };
  const check = async (name, expression) => { await sleep(80); if (!await run(expression)) throw Error(name); report.checks.push(name); };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 80 && !await run("!!document.querySelector('[data-wall-toolbar]')"); i++) await sleep(100);
    await run('localStorage.clear()');
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 80 && !await run("!!document.querySelector('[data-wall-toolbar]')"); i++) await sleep(100);
    await sleep(1000);
    for (let i = 0; i < 4; i++) {
      await run("document.querySelector('[aria-modal=true] [aria-label=Close]')?.click()");
      await sleep(350);
    }
    await check('intro dialogs dismissed', "!document.querySelector('[aria-modal=true]')");
    const changed = await run("!!document.querySelector('[data-wall-view-toggle]')");
    for (const width of [1440, 460]) {
      win.setContentSize(width, 900); await sleep(500);
      await shot(`toolbar-${width}`);
      await run(changed ? "document.querySelector('[data-wall-view-toggle]').click()" : "document.querySelector('[data-screens-button]').click()");
      await sleep(300);
      await shot(`view-${width}`);
      if (changed) {
        await check(`menu fits ${width}`, "(()=>{const r=document.querySelector('[data-wall-view-menu]').getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.bottom<=innerHeight})()");
        await run("document.querySelector('[data-wall-view-menu]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
        await check(`Escape closes ${width}`, "!document.querySelector('[data-wall-view-menu]')");
      } else await run("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))");
    }
    if (changed) {
      await run(`(() => {
        const bridge = window.nekkoChrome.displays;
        window.viewCalls = [];
        bridge.toggle = async (id, enabled) => { viewCalls.push(['toggle', id, enabled]); screensFixture.state = { ...screensFixture.state, displays: screensFixture.state.displays.map(d => d.id === id ? { ...d, enabled } : d) }; return screensFixture.state; };
        bridge.setPlacement = async placement => { viewCalls.push(['placement', placement]); screensFixture.state = { ...screensFixture.state, placement }; return screensFixture.state; };
      })()`);
      await run("document.querySelector('[data-wall-view-toggle]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))"); await sleep(150);
      await check('keyboard opens and focuses selected mode', "document.activeElement.matches('[data-view-mode=focus]')");
      await run("document.querySelector('[data-view-mode=grid]').click()"); await sleep(200);
      await check('multi-agent selected', "document.querySelector('[data-view-mode=grid]').checked");
      await run("document.querySelector('[data-view-snap]').click()"); await sleep(100);
      await check('snap enabled', "document.querySelector('[data-view-snap]').checked");
      await run("document.querySelector('[data-view-mode=focus]').click()"); await sleep(100);
      await check('single-agent disables but retains snap', "document.querySelector('[data-view-snap]').disabled && document.querySelector('[data-view-snap]').checked");
      await check('screens embedded', "!!document.querySelector('[data-wall-view-menu] [aria-label=\"Screens to use\"]') && !document.querySelector('[data-screens-button]')");
      await run("document.querySelector('[aria-label=\"Screen 2, off\"]').click()"); await sleep(100);
      await check('screen toggle calls bridge and reflects state', "viewCalls.some(c=>c[0]==='toggle' && c[1]==='2' && c[2]===true) && document.querySelector('[aria-label=\"Screen 2, on\"]').getAttribute('aria-checked')==='true'");
      await run("document.querySelectorAll('[name=screens-placement]')[1].click()");
      await check('placement calls bridge and reflects state', "viewCalls.some(c=>c[0]==='placement' && c[1]==='main-first') && document.querySelectorAll('[name=screens-placement]')[1].checked");
      await run("document.querySelector('[data-wall-view-menu]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
      await check('Escape restores trigger focus', "document.activeElement.matches('[data-wall-view-toggle]') && !document.querySelector('[data-wall-view-menu]')");
      await run("document.querySelector('[data-wall-view-toggle]').click()"); await sleep(100);
      win.setContentSize(460, 400); await sleep(300);
      await check('short window scrolls within bounds', "(()=>{const p=document.querySelector('[data-wall-view-menu]'), r=p.getBoundingClientRect(); return r.top>=0 && r.bottom<=innerHeight && p.scrollHeight>p.clientHeight})()");
      await shot('view-short');

      await run("document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))"); await sleep(100);
      await check('outside click closes', "!document.querySelector('[data-wall-view-menu]')");
    }
    report.window = { visible: win.isVisible(), focusable: win.isFocusable(), bounds: win.getBounds() };
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.errors.length ? 1 : 0);
});
