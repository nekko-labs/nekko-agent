// Full App monitor width, budget range and new-chat frost evidence. Run through layout-evidence-integration.cjs.
// NEKKO_TEST_SOURCE can point at an unchanged base tree for matching captures.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const js = value => JSON.stringify(value).replace(/</g, '\\u003c');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], checks: [], errors: [] };
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -10000, y: -10000, title: 'Monitor frost, isolated evidence', webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('show', () => report.errors.push('Window became visible'));
  win.on('focus', () => report.errors.push('Window took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  const run = code => win.webContents.executeJavaScript(code, true);
  try {
    await win.loadURL('about:blank');
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Page.enable');
    await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('nekko.commandWall', JSON.stringify({ root: { id: 'gradient-pane', kind: 'chat', refId: 'd' }, hero: 'd', watermark: 1, autoAdd: false, layout: { mode: 'focus' }, dock: { show: true, side: 'right' }, agentPanel: { show: true } }));` });
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 60 && !await run('!!document.querySelector("[data-clean-start] .clean-start")'); i++) await sleep(100);
    if (!await run('!!document.querySelector("[data-clean-start] .clean-start")')) throw Error('New chat did not mount');
    for (const width of [1440, 900, 390]) {
      win.setContentSize(width, 900); await sleep(700);
      const file = path.join(out, `new-chat-${width}.png`);
      fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG());
      report.captures.push(file);
      report.checks.push(await run(`(() => {
        const e = document.querySelector('[data-clean-start] .clean-start');
        const c = document.querySelector('[data-clean-start] .composer');
        const before = getComputedStyle(e, '::before'), after = getComputedStyle(e, '::after');
        const r = c.getBoundingClientRect(); const panel=e.closest('.panel'); const frost=getComputedStyle(panel); const composer=getComputedStyle(c); const edge=getComputedStyle(c,'::after');
        const rect=s=>{const e=document.querySelector(s);if(!e)return null;const b=e.getBoundingClientRect();return {x:b.x,right:b.right,width:b.width}}; const range=document.querySelector('[aria-label="Budget time range"]'); const buttons=range?[...range.querySelectorAll('button')].map(b=>({label:b.textContent,x:b.getBoundingClientRect().x,right:b.getBoundingClientRect().right,y:b.getBoundingClientRect().y})):[]; return {frostBackground:frost.backgroundColor,frostBlur:frost.backdropFilter,composerBorder:composer.borderColor,composerEdge:edge.display,dock:rect('.monitors-dock'),window:rect('.command-wall-window[data-wall-hero]'),wall:rect('.command-wall-layout'),monitor:rect('.monitors-dock__monitor'),rangeButtons:buttons, width: innerWidth, theme: document.documentElement.dataset.theme, gradient: before.backgroundImage, grain: after.backgroundImage, grainAnimation: after.animationName, grainPointerEvents: after.pointerEvents, composerVisible: r.width > 200 && r.left >= 0 && r.right <= innerWidth };
      })()`));
    }
    win.setContentSize(1440, 900); await sleep(400);
    await run(`document.querySelector('[aria-label="Budget time range"]').scrollIntoView({block:'center'})`);
    await sleep(200);
    const budgetFile=path.join(out,'budget-1440.png');
    fs.writeFileSync(budgetFile,(await win.capturePage(undefined,{stayHidden:true})).toPNG()); report.captures.push(budgetFile);
    const initialWidth=await run(`Number(document.querySelector('[aria-label="Resize monitors"]').getAttribute('aria-valuenow'))`);
    const key=async k=>{await run(`document.querySelector('[aria-label="Resize monitors"]').dispatchEvent(new KeyboardEvent('keydown',{key:${js(k)},bubbles:true}))`);await sleep(100);};
    await key('ArrowLeft'); await key('ArrowLeft');
    if(await run(`Number(document.querySelector('[aria-label="Resize monitors"]').getAttribute('aria-valuenow'))`)===initialWidth) throw Error('Resize did not grow dock');
    await key('ArrowRight'); await key('ArrowRight');
    if(await run(`Number(document.querySelector('[aria-label="Resize monitors"]').getAttribute('aria-valuenow'))`)!==initialWidth) throw Error('Resize did not snap to default');
    await key('ArrowLeft'); await key('Home');
    if(await run(`Number(document.querySelector('[aria-label="Resize monitors"]').getAttribute('aria-valuenow'))`)!==initialWidth) throw Error('Home did not reset dock');
    await key('ArrowLeft'); await run(`document.querySelector('[aria-label="Resize monitors"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`); await sleep(100);
    if(await run(`Number(document.querySelector('[aria-label="Resize monitors"]').getAttribute('aria-valuenow'))`)!==initialWidth) throw Error('Double-click did not reset dock');
    report.resizeChecks={initialWidth,snap:true,home:true,doubleClick:true};
    await run(`document.querySelector('[aria-label="Budget time range"] button:last-child').click()`);
    if(!await run(`document.querySelector('[aria-label="Budget time range"] button:last-child').getAttribute('aria-pressed')==='true'`)) throw Error('Budget range click failed');
    // Renderer input only. The overlay must not consume composer input.
    await run(`(() => { const e = document.querySelector('[data-clean-start] [contenteditable]'); if (!e) throw Error('Missing editor'); e.focus(); document.execCommand('insertText', false, 'Plan a desktop task'); })()`);
    if (!await run("document.querySelector('[data-clean-start] [contenteditable]').textContent.includes('Plan a desktop task')")) throw Error('Composer interaction failed');
    if(!process.env.NEKKO_TEST_SOURCE && !await run(`getComputedStyle(document.querySelector('[data-clean-start] .composer'),'::after').display==='none'`)) throw Error('Typing restored a hard outline');
    report.bounds = win.getBounds(); report.hidden = !win.isVisible(); report.focused = win.isFocused();
    if (!report.hidden || report.focused) throw Error('Isolation invariant failed');
    for(const c of report.checks) {
      if(c.rangeButtons.length!==6 || new Set(c.rangeButtons.map(b=>b.y)).size!==1 || c.rangeButtons.some(b=>b.x<c.monitor.x || b.right>c.monitor.right)) throw Error('Budget options must fit in one row');
      if(!process.env.NEKKO_TEST_SOURCE && ((c.dock.width!==276 && c.width>719) || c.frostBlur==='none' || c.composerEdge!=='none' || !c.composerVisible)) throw Error('Frost/default width acceptance failed');
    }
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-transparency',value:'reduce'}]});
    report.reducedTransparency=await run(`(()=>{const p=document.querySelector('[data-clean-start]').closest('.panel');return {blur:getComputedStyle(p).backdropFilter,background:getComputedStyle(p).backgroundColor}})()`);
    if(!process.env.NEKKO_TEST_SOURCE && report.reducedTransparency.blur!=='none') throw Error('Reduced transparency did not disable blur');
    report.success = true;
  } catch (e) { report.errors.push(String(e.stack || e)); report.success = false; }
  finally {
    fs.writeFileSync(path.join(out, 'monitor-frost-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2)); win.destroy(); app.exit(report.success ? 0 : 1);
  }
});
