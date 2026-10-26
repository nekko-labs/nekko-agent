// Hidden full-App completion/minimize evidence. No host, network or user profile.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { assertions: [], errors: [], captures: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: Number(process.env.NEKKO_TEST_WIDTH || 1440), height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -1700, y: -1100, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const run = s => win.webContents.executeJavaScript(s, true);
  const shot = async name => { const file = path.join(out, name + '.png'); fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(file); };
  const check = async (name, expr) => { const passed = !!await run(expr); report.assertions.push({ name, passed }); if (!passed) throw Error(name); };
  win.on('focus', () => report.errors.push('took focus'));
  const present = "!!document.querySelector('[data-grid-cell=\"chat:a\"]')";
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 60 && !await run('!!window.layoutFixture && !!document.querySelector("[data-command-wall]")'); i++) await sleep(200);
    await run(`localStorage.setItem('nekko.commandWall',JSON.stringify({layout:{mode:'grid',cols:2,rows:2},root:{id:'split_fixture',dir:'row',sizes:[0.5,0.5],children:[{id:'pane_a',kind:'chat',refId:'a'},{id:'pane_b',kind:'chat',refId:'b'}]},watermark:Date.now(),autoAdd:false,hero:'a'})); location.reload()`);
    await sleep(1500);
    await check('initial pane visible', present);
    await shot('before-reply');
    await run(`layoutFixture.emitAgent({type:'done',sessionId:'a',messageId:'reply',stop:'complete'})`);
    fs.mkdirSync(path.join(out, 'motion'), { recursive: true });
    for (let i = 0; i < 12; i++) { const f = path.join(out, 'motion', String(i).padStart(3,'0')+'.png'); fs.writeFileSync(f, (await win.capturePage(undefined, { stayHidden:true })).toPNG()); await sleep(40); }
    await sleep(800);
    await shot('after-reply');
    const baseline = process.env.NEKKO_TEST_BASELINE === '1';
    await check(baseline ? 'baseline keeps finished pane' : 'successful reply minimizes', baseline ? present : `!(${present})`);
    await check('record remains incomplete', "layoutFixture.records.some(s=>s.id==='a'&&!s.archivedAt)");
    await check('other pane remains', "!!document.querySelector('[data-grid-cell=\"chat:b\"]')");
    if (!baseline) {
      await run(`Array.from(document.querySelectorAll('[data-agent-panel] [role=button]')).find(e=>e.textContent.includes('Persist quota history'))?.click()`);
      await sleep(800);
      await check('sidebar restores pane', present);
      await shot('restored');
      await run(`layoutFixture.emitAgent({type:'error',sessionId:'a',message:'fixture failure'})`); await sleep(300);
      await check('error stays visible', present);
      await run(`layoutFixture.emitAgent({type:'done',sessionId:'a',messageId:'loop',stop:'loop'})`); await sleep(300);
      await check('loop stop stays visible', present);
      await run(`localStorage.setItem('fixture.pending',JSON.stringify({a:{kind:'question'}})); layoutFixture.emitAgent({type:'done',sessionId:'a',messageId:'waiting',stop:'complete'})`); await sleep(300);
      await check('pending input stays visible', present);
      await run(`localStorage.removeItem('fixture.pending'); layoutFixture.originalPending = layoutFixture.bridge.pendingInput; layoutFixture.bridge.pendingInput = () => Promise.reject(Error('offline')); layoutFixture.emitAgent({type:'done',sessionId:'a',messageId:'unavailable',stop:'complete'})`); await sleep(300);
      await check('failed input check stays visible', present);
      await run(`layoutFixture.bridge.pendingInput = () => new Promise(resolve => { layoutFixture.resolvePending = resolve; }); layoutFixture.emitAgent({type:'done',sessionId:'a',messageId:'old',stop:'complete'}); layoutFixture.emitAgent({type:'text_delta',sessionId:'a',text:'New work'}); layoutFixture.resolvePending({})`); await sleep(300);
      await check('newer work defeats stale completion', present);
      await run(`layoutFixture.bridge.pendingInput = layoutFixture.originalPending`);
      // The real toolbar button is found by its title, independent of wrapper markup.
      await run(`Array.from(document.querySelectorAll('button')).find(e=>e.title.startsWith('Focused ('))?.click()`); await sleep(400);
      await check('focused mode selected', `document.querySelector('[data-command-wall]')?.dataset.wallLayout === 'focus'`);
      await run(`layoutFixture.emitAgent({type:'done',sessionId:'a',messageId:'focused',stop:'complete'})`); await sleep(400);
      await check('focused reply stays visible', present);

    }
    report.bounds = win.getBounds(); report.hidden = !win.isVisible();
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
  win.destroy(); app.exit(report.errors.length ? 1 : 0);
});
