// Hidden full-App evidence for renaming a zone from its name bar's menu. No host, network or user profile.
// NEKKO_TEST_BASELINE=1 captures only the menu (for a run against main).
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { assertions: [], errors: [], captures: [] };
const js = (v) => JSON.stringify(v).replace(/[<>/\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -1700, y: -1100, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const run = s => win.webContents.executeJavaScript(s, true);
  const shot = async name => { const file = path.join(out, name + '.png'); fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(file); };
  const check = async (name, expr) => { const passed = !!await run(expr); report.assertions.push({ name, passed }); if (!passed) throw Error(name); };
  const center = async sel => run(`(() => { const r = document.querySelector(${js(sel)}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  const rightClick = async sel => {
    const p = await center(sel);
    win.webContents.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'right', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'contextMenu', x: p.x, y: p.y });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'right', clickCount: 1 });
    await sleep(300);
  };
  const menuItem = text => `Array.from(document.querySelectorAll('[role=menuitem]')).find(e => e.textContent === ${js(text)})`;
  const key = k => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: k }); if (k.length === 1) win.webContents.sendInputEvent({ type: 'char', keyCode: k }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: k }); };
  const saved = `JSON.parse(localStorage.getItem('nekko.commandWall')).root.children.map(p => p.zone).join('|')`;
  win.on('focus', () => report.errors.push('took focus'));
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 60 && !await run('!!window.layoutFixture && !!document.querySelector("[data-command-wall]")'); i++) await sleep(200);
    await run(`localStorage.setItem('nekko.commandWall',JSON.stringify({layout:{mode:'grid',cols:2,rows:1},root:{id:'split_fixture',dir:'row',sizes:[0.5,0.5],children:[{id:'pane_a',kind:'chat',refId:'a',zone:'Zone 1',tint:0},{id:'pane_b',kind:'chat',refId:'b',zone:'Zone 2',tint:1}]},watermark:Date.now(),autoAdd:false,hero:'a',zonesIntro:true})); location.reload()`);
    await sleep(2500);
    await check('two zones', `document.querySelectorAll('.wall-zone-header').length === 2`);
    await rightClick('[data-zone="Zone 2"] .wall-zone-header');
    await shot('zone-menu');
    if (process.env.NEKKO_TEST_BASELINE !== '1') {
      await check('menu offers Rename zone', `!!${menuItem('Rename zone')}`);
      await run(`${menuItem('Rename zone')}.click()`);
      await sleep(300);
      await check('name bar turns into a field with the name selected', `(() => { const i = document.activeElement; return i?.matches('[data-zone="Zone 2"] .wall-zone-rename') && i.value === 'Zone 2' && i.selectionStart === 0 && i.selectionEnd === 6; })()`);
      for (const k of 'Backend') key(k);
      await sleep(200);
      await shot('renaming');
      key('Return');
      await sleep(400);
      await check('Enter saves the name', `!!document.querySelector('[data-zone="Backend"] .wall-zone-name') && !document.querySelector('.wall-zone-rename')`);
      await check('the name is kept with the board', `${saved} === 'Zone 1|Backend'`);
      await shot('renamed');
      // Escape leaves the name as it was.
      await rightClick('[data-zone="Zone 1"] .wall-zone-header');
      await run(`${menuItem('Rename zone')}.click()`);
      await sleep(300);
      for (const k of 'Nope') key(k);
      key('Escape');
      await sleep(400);
      await check('Escape cancels', `${saved} === 'Zone 1|Backend' && !document.querySelector('.wall-zone-rename')`);
      // A blank name keeps the old one.
      await rightClick('[data-zone="Backend"] .wall-zone-header');
      await run(`${menuItem('Rename zone')}.click()`);
      await sleep(300);
      key('Backspace'); key('Return');
      await sleep(400);
      await check('blank keeps the old name', `${saved} === 'Zone 1|Backend'`);
    }
    report.bounds = win.getBounds(); report.hidden = !win.isVisible();
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ assertions: report.assertions, errors: report.errors, bounds: report.bounds, hidden: report.hidden }, null, 2));
  win.destroy(); app.exit(report.errors.length ? 1 : 0);
});
