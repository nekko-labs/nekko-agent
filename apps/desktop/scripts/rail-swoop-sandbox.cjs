// Left-rail evidence: the full App fixture at rest and hovered, in both themes,
// plus frames of the open and close motion. Hidden, off-screen, non-focusable;
// hover is a renderer input event, never OS input. Launch through
// layout-evidence-integration.cjs with NEKKO_LAYOUT_SANDBOX=rail-swoop-sandbox.cjs.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], metrics: {}, errors: [], checks: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const minX = Math.min(...screen.getAllDisplays().map(d => d.bounds.x)), minY = Math.min(...screen.getAllDisplays().map(d => d.bounds.y));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: minX - 1700, y: minY - 1100, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => { report.errors.push('took focus'); });
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const capture = rect => win.capturePage(rect, { stayHidden: true, stayAwake: false });
  const shot = async (name, rect) => { const f = path.join(out, name + '.png'); fs.writeFileSync(f, (await capture(rect)).toPNG()); report.captures.push(f); };
  const move = (x, y) => win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
  const crop = { x: 0, y: 0, width: 560, height: 900 };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 50 && !(await run("!!document.querySelector('.rail .nav-item')")); i++) await sleep(200);
    await sleep(900);
    const target = JSON.parse(await run("JSON.stringify((() => { const b = document.querySelector('.rail .nav-item').getBoundingClientRect(); return { x: Math.round(b.left + 20), y: Math.round(b.top + 20) }; })())"));
    for (const theme of ['dark', 'light']) {
      await run(`document.documentElement.dataset.theme = '${theme}'`);
      move(900, 450); await sleep(900);
      await shot(`rail-rest-${theme}`, crop);
      move(target.x, target.y); await sleep(900);
      await shot(`rail-open-${theme}`, crop);
      report.metrics[theme] = JSON.parse(await run("JSON.stringify((() => { const r = document.querySelector('.rail'); const p = document.querySelector('.rail-backdrop path'); return { railWidth: Math.round(r.getBoundingClientRect().width), hovered: r.matches(':hover'), d: p ? getComputedStyle(p).d.slice(0, 120) : null }; })())"));
    }
    if (process.env.NEKKO_RAIL_WINGS) {
      const check = async (name, expression) => {
        if (!await run(expression)) throw Error(name);
        report.checks.push(name);
      };
      move(900, 450); await sleep(400);
      const restPath = await run("document.querySelector('.rail-backdrop path').getAttribute('d')");
      await run("document.querySelector('.rail').setAttribute('data-open', '')"); await sleep(400);
      await check('pin opens to 198px', "Math.round(document.querySelector('.rail').getBoundingClientRect().width) === 198");
      await check('viewport widens without path morph or blur', "(() => { const s=getComputedStyle(document.querySelector('.rail-backdrop')); const p=getComputedStyle(document.querySelector('.rail-backdrop path')); return Math.round(document.querySelector('.rail-backdrop').getBoundingClientRect().width)===198 && s.clipPath==='none' && s.backdropFilter==='none' && p.transitionDuration==='0s'; })()");
      if (restPath !== await run("document.querySelector('.rail-backdrop path').getAttribute('d')")) throw Error('path changed during expansion');
      report.checks.push('path is identical at rest and expanded');
      await run("document.querySelector('.rail').removeAttribute('data-open')"); await sleep(400);
      win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
      await run("document.querySelector('.rail .nav-item').focus()");
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' }); await sleep(400);
      await check('keyboard focus opens rail', "document.querySelector('.rail').matches(':has(:focus-visible)') && Math.round(document.querySelector('.rail').getBoundingClientRect().width)===198");
      await run("document.activeElement.blur()"); move(900, 450); await sleep(400);
      await check('feedback remains pointer reachable', "getComputedStyle(document.querySelector('.rail-feedback')).pointerEvents==='auto'");
      const tail = JSON.parse(await run("JSON.stringify((() => { const r=document.querySelector('.rail-backdrop').getBoundingClientRect(); return {x:Math.ceil(r.x+1), y:Math.round(r.bottom-16)}; })())"));
      move(tail.x, tail.y); await sleep(400);
      await check('painted lower wing keeps hover open', "document.querySelector('.rail').matches(':hover') && Math.round(document.querySelector('.rail').getBoundingClientRect().width)===198");
      move(900, 450); await sleep(400);
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{name:'prefers-reduced-motion',value:'reduce'}] });
      await check('reduced motion disables viewport transitions', "getComputedStyle(document.querySelector('.rail-backdrop')).transitionDuration==='0s'");
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
      win.webContents.debugger.detach();
    }
    for (const width of [900, 390]) {
      move(500, 10); await run("document.activeElement?.blur()");
      win.setContentSize(width, 900); await sleep(300); move(500, 10); await sleep(500);
      await shot(`rail-rest-light-${width}`, {x:0,y:0,width,height:900});
      report.metrics[width] = await run("({railVisible:document.querySelector('.rail').getBoundingClientRect().width>0,overflow:document.documentElement.scrollWidth>innerWidth,railWidth:document.querySelector('.rail').getBoundingClientRect().width,hovered:document.querySelector('.rail').matches(':hover'),focus:document.querySelector('.rail').matches(':has(:focus-visible)')})");
      if (width===900) {
        const pt = await run("(()=>{const r=document.querySelector('.rail .nav-item').getBoundingClientRect();return {x:r.x+20,y:r.y+20}})()");
        move(pt.x,pt.y); await sleep(400);
        await shot(`rail-open-light-${width}`, {x:0,y:0,width,height:900});
      }
    }
    win.setContentSize(1440, 900); await sleep(500);
    // Motion, light theme: frames while opening, then while closing.
    for (const phase of ['open', 'close']) {
      const dir = path.join(out, `motion-${phase}`);
      fs.mkdirSync(dir, { recursive: true });
      if (phase === 'open') { move(900, 450); await sleep(900); move(target.x, target.y); }
      else { move(target.x, target.y); await sleep(900); move(900, 450); }
      const t0 = Date.now();
      for (let i = 0; i < 24; i++) {
        fs.writeFileSync(path.join(dir, String(i).padStart(3, '0') + '.png'), (await capture(crop)).toPNG());
        await sleep(Math.max(0, t0 + (i + 1) * 33 - Date.now()));
      }
    }
  } catch (e) { report.failed = true; report.errors.push(String(e && e.stack || e)); }
  report.window = { visible: win.isVisible(), focused: win.isFocused(), bounds: win.getBounds(), profile: app.getPath('userData') };
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.captures.length && !report.failed ? 0 : 1);
});
