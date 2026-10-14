const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], metrics: {}, errors: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const minX = Math.min(...screen.getAllDisplays().map(d => d.bounds.x)), minY = Math.min(...screen.getAllDisplays().map(d => d.bounds.y));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: minX - 1700, y: minY - 1100, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => { report.errors.push('took focus'); });
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const shot = async name => { const f = path.join(out, name + '.png'); fs.writeFileSync(f, (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG()); report.captures.push(f); };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 50 && !(await run("!!document.querySelector('.rail') && !!document.querySelector('[data-command-wall]')")); i++) await sleep(200);
    await sleep(900);
    await shot('agents-1440x900');
    report.metrics = JSON.parse(await run(`JSON.stringify((() => {
      const r = s => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height), r: Math.round(b.right) }; };
      return { rail: r('.rail'), mark: r('.titlebar-mark'), firstNav: r('.nav-item'), panel: r('[data-agent-panel]'), column: r('.wall-column'), window: r('.command-wall-layout'), dock: r('.wall-dock'), viewport: innerWidth };
    })())`));
    // Expanded rail: CDP hover is avoided, so an injected class mirrors :hover.
    await run("document.querySelector('.rail').classList.add('rail-force-open')");
    await win.webContents.insertCSS('.rail.rail-force-open{width:188px}.rail.rail-force-open .rail-label{opacity:1;transform:none}');
    await sleep(500);
    await shot('rail-expanded');
    // Motion: 12 frames of the expand transition.
    await run("document.querySelector('.rail').classList.remove('rail-force-open')"); await sleep(500);
    fs.mkdirSync(path.join(out, 'motion'), { recursive: true });
    await run("document.querySelector('.rail').classList.add('rail-force-open')");
    for (let i = 0; i < 14; i++) { fs.writeFileSync(path.join(out, 'motion', String(i).padStart(3, '0') + '.png'), (await win.capturePage({ x: 0, y: 0, width: 420, height: 900 }, { stayHidden: true })).toPNG()); await sleep(30); }
    // Dashboard dock open.
    await run("(()=>{const s=layoutFixture.store.getState();layoutFixture.store.setState({settings:{...s.settings,commandWall:{...(s.settings.commandWall||{}),dock:{...((s.settings.commandWall||{}).dock||{}),show:true,side:'right'}}}})})()");
    await sleep(800);
    report.metrics.dockOpen = JSON.parse(await run("JSON.stringify((()=>{const e=document.querySelector('.wall-dock');return e?Math.round(e.getBoundingClientRect().width):null})())"));
    await shot('agents-dock-open');
  } catch (e) { report.errors.push(String(e && e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.captures.length ? 0 : 1);
});
