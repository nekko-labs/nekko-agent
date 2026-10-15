const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const dir = process.env.NEKKO_EVIDENCE_DIR, kind = process.env.NEKKO_EVIDENCE_KIND;
const profile = fs.mkdtempSync(path.join(dir, 'profile-'));
app.setPath('userData', profile); app.setPath('sessionData', profile);
app.commandLine.appendSwitch('disable-background-networking'); app.commandLine.appendSwitch('force-device-scale-factor', '1');
const report = { kind, checks: [], captures: [], errors: [], blockedRequests: [], visuallyInspected: false, limitations: ['New response artifact cards have no before state. Before captures show base Markdown and PlanRail.', 'Hidden Electron pixels do not verify native OS chrome.', 'No image-view or browser tool is exposed to this agent; actual pixel inspection remains required.'] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((request, done) => { const cancel = !/^(file:|data:|blob:)/.test(request.url); if (cancel) report.blockedRequests.push(request.url); done({ cancel }); });
  session.defaultSession.setPermissionRequestHandler((w, p, done) => done(false)); session.defaultSession.setPermissionCheckHandler(() => false);
  const win = new BrowserWindow({ title: 'Isolated artifact cards evidence', width: 1440, height: 1000, useContentSize: true, x: -20000, y: -20000, show: false, focusable: false, skipTaskbar: true, webPreferences: { offscreen: true, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('Fixture took OS focus'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('console-message', event => { if (event.level === 'error') report.errors.push(event.message); });
  const run = script => win.webContents.executeJavaScript(script, true);
  const stable = () => run(`(async()=>{await document.fonts.ready;for(let i=0;i<8;i++)await new Promise(r=>requestAnimationFrame(r));return {width:innerWidth,height:innerHeight,theme:document.documentElement.dataset.theme}})()`);
  const check = async (name, script) => { const passed = !!await run(script); report.checks.push({ name, passed }); if (!passed) throw Error(name); };
  const capture = async name => { const dom = await stable(); const image = await win.capturePage(undefined, { stayHidden: true, stayAwake: true }); if (image.isEmpty()) throw Error('Empty capture'); const file = path.join(dir, name + '.png'); fs.writeFileSync(file, image.toPNG()); report.captures.push({ file, dom, size: image.getSize() }); };
  try {
    await win.loadFile(path.join(dir, 'index.html')); await stable();
    for (const width of [1440, 600]) for (const theme of ['light', 'dark']) {
      win.setContentSize(width, 1000); await run(`document.documentElement.dataset.theme='${theme}'`); await stable();
      const label = `${width}-${theme}`;
      await check(label + ' exact viewport and theme', `innerWidth===${width}&&innerHeight===1000&&document.documentElement.dataset.theme==='${theme}'`);
      await check(label + ' real Markdown and preserved plan', `!!document.querySelector('[data-chat] button, [data-chat] a')&&document.querySelector('[data-rail]').innerText.includes('Review options before deleting anything')&&document.querySelector('[data-rail]').innerText.toLowerCase().includes('after this')`);
      await check(label + ' no horizontal shell overflow', 'document.documentElement.scrollWidth<=innerWidth');
      if (kind === 'before') {
        await check(label + ' no baseline cards or artifacts section', `!document.querySelector('[aria-label="Response artifacts"]')&&!document.querySelector('[data-rail] details')`);
        await capture(label + '-planrail-baseline');
      } else {
        await check(label + ' chat count deduplicated to two', `document.querySelectorAll('[data-chat] [aria-label="Response artifacts"] button').length===2`);
        await check(label + ' rail count and initially collapsed', `(()=>{const d=document.querySelector('[data-rail] details');return !d.open&&d.querySelector('summary').textContent.trim().replace(/\\s+/g,' ')==='Artifacts 2'})()`);
        await capture(label + '-collapsed');
        // CDP input activates the native details disclosure without OS input or focus.
        win.webContents.debugger.attach('1.3');
        const point = await run(`(()=>{const r=document.querySelector('[data-rail] summary').getBoundingClientRect();return {x:r.x+20,y:r.y+r.height/2}})()`);
        for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
        win.webContents.debugger.detach(); await stable();
        await check(label + ' expanded rail shows same two artifacts', `document.querySelector('[data-rail] details').open&&document.querySelectorAll('[data-rail] [aria-label="Response artifacts"] button').length===2`);
        await capture(label + '-expanded');
        await run(`document.querySelector('[data-chat] [aria-label="Response artifacts"] button').click();document.querySelector('[data-rail] [aria-label="Response artifacts"] button').click();[...document.querySelectorAll('[data-chat] button')].find(b=>b.textContent==='Disk audit and cleanup proposal').click()`);
        await check(label + ' chat rail Markdown callbacks preserve same session', `evidence.opens.slice(-3).length===3&&evidence.opens.slice(-3).every(x=>x.path==='C:/fixture/project/reports/disk-audit/README.md'&&x.sessionId===evidence.sessionId)`);
        await run(`document.querySelector('[data-rail] details').open=false`); await stable();
        await check(label + ' collapsed content not visible', `!document.querySelector('[data-rail] details').open&&![...document.querySelectorAll('[data-rail] details button')].some(b=>b.checkVisibility())`);
      }
      report.checks.push({ name: label + ' hidden nonfocusable fixture', passed: !win.isVisible() && !win.isFocusable() && !win.isFocused() });
    }
    report.callbacks = await run('evidence.opens');
    report.background = { visible: win.isVisible(), focusable: win.isFocusable(), focused: win.isFocused(), bounds: win.getBounds(), electron: process.versions.electron };
  } catch (error) { report.errors.push(String(error)); report.dom = await run('document.body.innerText').catch(() => 'unavailable'); }
  finally { fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(report, null, 2)); console.log(kind, JSON.stringify({ checks: report.checks.length, captures: report.captures.length, errors: report.errors })); win.destroy(); app.exit(report.errors.length || report.checks.some(c => !c.passed) ? 1 : 0); }
});
