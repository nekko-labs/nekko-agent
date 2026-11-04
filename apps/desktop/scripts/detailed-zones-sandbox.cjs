// Hidden full-App checks. No host, network, native clipboard, or user profile.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
const profile = path.join(out, 'profile-' + process.pid);
app.setPath('userData', profile);
app.disableHardwareAcceleration();
const baseline = !!process.env.NEKKO_TEST_SOURCE;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const js = v => JSON.stringify(v).replace(/[<>/\u2028\u2029]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const report = { checks: [], errors: [], captures: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -10000, y: -10000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('show', () => report.errors.push('Window became visible'));
  win.on('focus', () => report.errors.push('Window took focus'));
  const run = code => win.webContents.executeJavaScript(code, true);
  const shot = async name => {
    // Hidden Chromium can return its previous composited frame on the first read.
    await run(`document.getAnimations().forEach(a => { try { a.finish(); } catch {} })`);
    await win.capturePage(undefined, { stayHidden: true }); await sleep(150);
    const f = path.join(out, name + '.png'); fs.writeFileSync(f, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(f);
  };
  const check = async (name, code) => { const value = !!await run(code); report.checks.push({ name, value }); if (!value) throw Error(name); };
  const frames = async (name, count, interval) => { fs.mkdirSync(path.join(out, name), { recursive: true }); for (let i = 0; i < count; i++) { await shot(name + '/' + String(i).padStart(3, '0')); await sleep(interval); } };
  try {
    await win.loadURL('about:blank');
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Page.enable');
    await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('nekko.commandWall',JSON.stringify({zones:true,zonesIntro:true,root:{id:'split',dir:'row',children:[{id:'pane_a',kind:'chat',refId:'a',zone:'Zone 1'},{id:'pane_b',kind:'chat',refId:'b',zone:'Zone 2'}],sizes:[0.5,0.5]},hero:'a',watermark:1,autoAdd:false,layout:{mode:'grid'},dock:{show:false},agentPanel:{show:true}}));` });
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 80 && !await run('!!window.layoutFixture && !!document.querySelector("[data-zone]")'); i++) await sleep(100);
    await run(`(() => { const h=document.documentElement; const off=()=>h.removeAttribute('data-app-inactive'); off(); new MutationObserver(off).observe(h,{attributes:true,attributeFilter:['data-app-inactive']}); })()`);
    await sleep(1000);
    await shot('zones');
    await run(`window.beforeWidth = document.querySelector('[data-zone="Zone 1"]').getBoundingClientRect().width`);
    const plus = baseline ? '.wall-zone-rail[data-side="right"] .wall-zone-add' : '.wall-zone-add';
    const point = await run(`(() => { const r=document.querySelector(${js(plus)}).getBoundingClientRect(); return { x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2) }; })()`);
    report.plus = await run(`(() => { const e=document.querySelector(${js(plus)}),r=e.getBoundingClientRect(); return { rect:r.toJSON(),hit:document.elementFromPoint(${point.x},${point.y})?.outerHTML.slice(0,300) }; })()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 1, y: 1 });
    await sleep(100);
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    await sleep(100);
    // Exercise React's pointer path as well as renderer input in hidden Electron.
    await run(`document.querySelector(${js(plus)}).dispatchEvent(new PointerEvent('pointerover',{bubbles:true,pointerType:'mouse'}))`);
    if (!baseline) {
      const pngs = [];
      for (let i = 0; i < 20; i++) { pngs.push((await win.capturePage(undefined, { stayHidden: true })).toPNG()); await sleep(80); }
      const gif = path.join(out, 'zone-hover.gif'); require('./evidence-gif.cjs')(gif, pngs, 8); report.captures.push(gif);
    }
    await sleep(450);
    await check('hover has landing preview', '!!document.querySelector(".wall-zone-ghost")');
    await shot('zone-hover');
    if (!baseline) {
      await check('hover pushes existing zones', `document.querySelector('[data-zone="Zone 1"]').getBoundingClientRect().width < window.beforeWidth - 50`);
      await check('plus stays on header line', `(() => { const a=document.querySelector('.wall-zone-add').getBoundingClientRect(),b=document.querySelector('.wall-zone-header').getBoundingClientRect(); return Math.abs(a.y-b.y)<4; })()`);
      await check('only one add button, no bottom rail', 'document.querySelectorAll(".wall-zone-add").length === 1 && !document.querySelector(".wall-zone-rail")');
      await run(`window.hoverWidth=document.querySelector('[data-zone="Zone 1"]').getBoundingClientRect().width`);
      await run(`document.querySelector('.wall-zone-add').click()`);
      await sleep(500);
      await check('click creates full-height column, matching preview', `(() => { const zs=[...document.querySelectorAll('[data-zone]')]; return zs.length===3 && Math.abs(zs[0].getBoundingClientRect().width-window.hoverWidth)<2 && Math.abs(zs[2].getBoundingClientRect().height-zs[0].getBoundingClientRect().height)<2; })()`);
      await shot('zone-added');
    }
    win.webContents.sendInputEvent({ type:'mouseMove', x:1, y:1 });
    // Reset the board so base and head composer evidence has identical layout.
    await win.reload(); await sleep(2200);
    const source = '`\n<svg width="45" height="45">\n  <circle cx="22" cy="22" r="8" />\n</svg>\n`';
    await run(`(() => { const el=document.querySelector('[data-chat-surface] [contenteditable="plaintext-only"]'); el.focus(); el.setSelectionRange(0,el.value.length); const data=new DataTransfer(); data.setData('text/plain',${js(source)}); el.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data})); })()`);
    await sleep(500);
    await check('paste keeps exact code text', `document.querySelector('[data-chat-surface] [contenteditable]').value === ${js(source)}`);
    if (!baseline) {
      await check('single tick code is highlighted', `!!document.querySelector('[data-chat-surface] [data-composer-code]')`);
      await check('pasted SVG never becomes markup', `!document.querySelector('[data-chat-surface] [contenteditable] svg')`);
    }
    await shot('plan-composer');
    // A web-sized narrow view uses this same editor and mode switch.
    win.setContentSize(390,844); await sleep(700); await shot('narrow-composer');
    if (!baseline) await check('Detailed mode accessibility label', `!!document.querySelector('[aria-label="Detailed: every control"]')`);
    if (!baseline) {
      await run(`(() => { const e=document.querySelector('[data-chat-surface] [contenteditable]'); e.focus(); e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,cancelable:true})); })()`);
      await sleep(500);
      await check('submission preserves raw single-tick source', `layoutFixture.lastSend?.text === ${js(source)}`);
    }
    win.setContentSize(1440,900);
    await run(`layoutFixture.store.getState().setView('settings')`); await sleep(900);
    await run(`[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Simple mode').click()`); await sleep(600);
    await shot('mode-settings');
    if (!baseline) await check('settings consistently names Detailed', `document.querySelector('[data-settings-group="simple"]')?.textContent.includes('Detailed') || [...document.querySelectorAll('button')].some(e=>e.textContent.trim()==='Detailed')`);
  } catch(e) { report.errors.push(String(e.stack || e)); }
  report.success = report.errors.length===0;
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
  app.exit(report.success ? 0 : 1);
});
