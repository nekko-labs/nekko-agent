// Picks a window up off the Agent board with renderer input (sendInputEvent),
// in a hidden, off-screen, non-focusable window, and captures each stage.
// With NEKKO_TEST_REVISION it captures the old drop band instead (synthetic
// drag events), for the PR's "before" column.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through wall-pickup-integration.cjs');
const runDir = path.join(out, new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(runDir, { recursive: true });
app.setPath('userData', path.join(runDir, 'profile'));
app.setPath('sessionData', path.join(runDir, 'profile'));
const report = { checks: [], errors: [], captures: [] };
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, done) => done(false));
  const win = new BrowserWindow({ width: 1200, height: 800, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: Math.min(...screen.getAllDisplays().map(d => d.bounds.x)) - 1400, y: Math.min(...screen.getAllDisplays().map(d => d.bounds.y)) - 1100, title: 'Synthetic Agent board pick-up verification', webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.on('focus', () => { report.errors.push('Verification window took OS focus'); process.exitCode = 1; });
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const check = async (name, expression) => { await sleep(120); if (!await run(expression)) throw Error(name); report.checks.push(name); };
  const capture = async (name, wait = 350) => { await sleep(wait); const file = path.join(runDir, name + '.png'); fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG()); report.captures.push(file); };
  const mouse = (type, x, y) => win.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
  // One fixed script per element, so no page code is ever built from a string.
  const RECTS = {
    strip3: "[data-wall-pane='p3'] [data-pane-title-strip]", strip2: "[data-wall-pane='p2'] [data-pane-title-strip]",
    left: "[data-wall-pane='p1']", card: '.wall-held-card', stage: '.command-wall-pane-stage',
  };
  const RECT_SCRIPTS = Object.fromEntries(Object.entries(RECTS).map(([key, sel]) => [key, `(()=>{const r=document.querySelector("${sel.replaceAll('"', '')}").getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`]));
  const rectOf = key => run(RECT_SCRIPTS[key]);
  const boxes = () => run(`JSON.stringify([...document.querySelectorAll('.command-wall-window')].map(w=>[w.dataset.wallPane,w.style.left,w.style.top,w.style.width,w.style.height]))`);
  const current = !process.env.NEKKO_TEST_REVISION;
  try {
    await win.loadFile(path.join(out, 'index.html')); win.showInactive(); await sleep(900);
    await check('board mounted', "!!document.querySelector('[data-command-wall]')");
    // Three chats: one tall on the left, two stacked on the right.
    await run(`(async()=>{await window.nekko.createSession('w');await window.nekko.createSession('w');await integration.state().refreshSessions();
      const wall=integration.state().settings.commandWall;
      await integration.configureWall({...wall,layout:{...wall.layout,mode:'grid'},autoAdd:false,root:{id:'s0',dir:'row',sizes:[0.45,0.55],children:[{id:'p1',kind:'chat',refId:'existing'},{id:'s1',dir:'col',sizes:[0.5,0.5],children:[{id:'p2',kind:'chat',refId:'new-1'},{id:'p3',kind:'chat',refId:'new-2'}]}]}});})()`);
    await sleep(1200);
    await check('three windows on the board', "document.querySelectorAll('.command-wall-window').length===3");
    await capture('1-rest');
    const strip = await rectOf('strip3');
    const left = await rectOf('left');
    const grab = { x: strip.x + 60, y: strip.y + strip.height / 2 };
    const under = { x: left.x + left.width / 2, y: left.y + left.height - 60 };
    if (!current) {
      // The old drag: native drag events; the target window showed a band inside itself.
      await run(`(()=>{const dt=new DataTransfer();window.__dt=dt;document.querySelector("[data-wall-pane='p3'] [data-pane-title-strip]").dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:dt}));})()`);
      await sleep(300);
      await run(`(()=>{const o=[...document.querySelectorAll("[data-wall-pane='p1'] .z-20")].pop();o.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:window.__dt,clientX:${under.x},clientY:${under.y}}));})()`);
      await capture('3-zone-under');
    } else {
      const before = await boxes();
      mouse('mouseMove', grab.x, grab.y); mouse('mouseDown', grab.x, grab.y);
      await capture('2a-picking', 70);
      await capture('2b-held', 300);
      await check('press lifts the window in place', "!!document.querySelector('[data-wall-pane=p3][data-wall-lifted]') && !!document.querySelector('.wall-held-card') && !!document.querySelector('.wall-drag-shield')");
      if (await boxes() !== before) throw Error('press moved a window');
      report.checks.push('press moves no window');
      for (let i = 1; i <= 4; i++) { mouse('mouseMove', grab.x, grab.y - i * 5); await sleep(30); }
      await sleep(300);
      if (await boxes() !== before) throw Error('nudging up moved a window');
      report.checks.push('a small move near the spot moves no window');
      const frames = 10;
      for (let i = 1; i <= frames; i++) { mouse('mouseMove', grab.x + (under.x - grab.x) * i / frames, grab.y + (under.y - grab.y) * i / frames); await capture(`frame-${String(i).padStart(2, '0')}`, 40); }
      await capture('3-zone-under');
      await check('zone opens under the left window', "(()=>{const z=document.querySelector('[data-wall-pane=p3]').getBoundingClientRect();const l=document.querySelector('[data-wall-pane=p1]').getBoundingClientRect();return z.top>l.bottom-1 && Math.abs(z.left-l.left)<2})()");
      const card = await rectOf('card');
      if (Math.abs(card.x - (under.x - (grab.x - strip.x) * card.width / strip.width)) > 40) throw Error('card did not follow the pointer');
      report.checks.push('card follows the pointer');
      const stage = await rectOf('stage');
      mouse('mouseMove', stage.x + 4, stage.y + stage.height / 2);
      await capture('4-zone-edge');
      await check('left board edge previews a full-height column', "(()=>{const z=document.querySelector('[data-wall-pane=p3]').getBoundingClientRect();const s=document.querySelector('.command-wall-pane-stage').getBoundingClientRect();return Math.abs(z.left-s.left)<2 && z.height>s.height-4})()");
      mouse('mouseMove', under.x, under.y); await sleep(300);
      mouse('mouseUp', under.x, under.y);
      await capture('5-dropped');
      await check('drop commits and clears the hold', "!document.querySelector('[data-wall-lifted]') && !document.querySelector('.wall-held-card')");
      const settled = await boxes();
      // Escape puts it back.
      const strip2 = await rectOf('strip2');
      mouse('mouseMove', strip2.x + 60, strip2.y + 10); mouse('mouseDown', strip2.x + 60, strip2.y + 10); await sleep(100);
      mouse('mouseMove', under.x, 120); await sleep(300);
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); await sleep(400);
      mouse('mouseUp', under.x, 120); await sleep(300);
      if (await boxes() !== settled) throw Error('Escape did not cancel');
      report.checks.push('Escape cancels the move');
    }
  } catch (e) { report.errors.push(String(e && e.stack || e)); process.exitCode = 1; }
  fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ runDir, checks: report.checks, errors: report.errors }, null, 2));
  app.exit(process.exitCode || 0);
});
