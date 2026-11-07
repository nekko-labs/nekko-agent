// Real App, isolated profile and no network. Run through layout-evidence-integration.cjs.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], assertions: [], errors: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('took focus'));
  const run = s => win.webContents.executeJavaScript(s, true);
  const wait = async s => { for (let i = 0; i < 80; i++) { if (await run(s)) return; await sleep(100); } throw Error('Timed out: ' + s); };
  const shot = async name => {
    // Hidden Electron pauses entrance animations. Settle finite entrances for stills.
    await run("document.getAnimations().forEach(a => { if (a.effect?.getComputedTiming().endTime < 2000) a.finish(); })");
    await run("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
    win.webContents.invalidate(); await sleep(200);
    const file = path.join(out, name + '.png');
    fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG());
    report.captures.push(file);
  };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    await wait("!!window.layoutFixture && !!layoutFixture.store.getState().settings");
    await run("window.nekko.updateSettings({firstPromptIntroSeen:true}).then(settings => layoutFixture.store.setState({settings}))");
    await wait("!!document.querySelector('.zones-intro [aria-label=\"Close\"]')");
    await run("document.querySelector('.zones-intro [aria-label=\"Close\"]').click()");
    await wait("!document.querySelector('.zones-intro')");
    await run("Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Dynamic').click()");
    await sleep(700);
    for (const width of [1440, 390]) {
      win.setContentSize(width, 900);
      await sleep(500);
      await wait("!!document.querySelector('[data-wall-create-toggle]')");
      await run("document.querySelector('[data-wall-create-toggle]').click()");
      await wait("!!document.querySelector('[data-wall-create-menu]')");
      await sleep(400);
      assert.equal(await run("(()=>{const r=document.querySelector('[data-wall-create-menu]').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()"), true);
      await shot('plus-menu-' + width);
      await run("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    }
    if (process.env.NEKKO_ZONE_EXPECT_NEW === '1') {
      win.setContentSize(1440, 900);
      await sleep(500);
      await run("document.querySelector('[data-wall-create-toggle]').click()");
      await wait("!!document.querySelector('[aria-label=\"Add agent zone\"]')");
      await sleep(700);
      const before = await run("JSON.stringify(layoutFixture.store.getState().settings.commandWall)");
      await run("document.querySelector('[aria-label=\"Add agent zone\"]').click()");
      await wait("!document.querySelector('[data-wall-create-menu]')");
      await sleep(900);
      const after = await run("JSON.stringify(layoutFixture.store.getState().settings.commandWall)");
      const leaves = n => !n ? [] : n.children ? n.children.flatMap(leaves) : [n];
      const b = JSON.parse(before), a = JSON.parse(after);
      assert.equal(leaves(a.root).length, leaves(b.root).length + 1);
      assert.deepEqual(a.layout, b.layout);
      const added = leaves(a.root).find(p => !leaves(b.root).some(old => old.id === p.id));
      assert.equal(added.kind, 'zone');
      assert.equal(a.activeZone, added.id);
      report.assertions.push('Adds exactly one empty active zone; preserves layout; dismisses menu; persists wall setting');
      await shot('zone-added-1440');
    }
    assert.equal(win.isVisible(), false);
    report.assertions.push('Menu fits 1440px and 390px viewports; window stayed hidden');
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.errors.length ? 1 : 0);
});
