const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const out = process.env.NEKKO_INTEGRATION_OUT;
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { captures: [], metrics: [], errors: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 720, height: 430, show: false, focusable: false, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('Unexpected focus'));
  const run = s => win.webContents.executeJavaScript(s);
  const shot = async name => { const file = path.join(out, `${name}.png`); fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(file); };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 80 && !await run("!!document.querySelector('.agent-chip')"); i++) await sleep(100);
    for (const theme of ['dark', 'light']) {
    await run(`document.documentElement.dataset.theme = '${theme}'`);
    for (const width of [720, 360]) {
      win.setContentSize(width, 430);
      win.webContents.sendInputEvent({ type: 'mouseMove', x: width - 1, y: 1 });
      await sleep(300);
      const metrics = await run(`Array.from(document.querySelectorAll('.agent-chip')).map(e => { const t=e.querySelector('time'), r=e.getBoundingClientRect(), b=t.getBoundingClientRect(); return { rightGap: r.right-b.right, titleWidth:e.querySelector('.truncate').getBoundingClientRect().width }; })`);
      report.metrics.push({ theme, width, metrics });
      if (process.env.NEKKO_ASSERT_FIXED) metrics.forEach(m => assert.ok(Math.abs(m.rightGap - 12) < 1, `timestamp gap ${m.rightGap}`));
      await shot(`agents-${theme}-${width}`);
    }
    }
    await run("document.documentElement.dataset.theme = 'dark'");
    const point = await run("(()=>{const r=document.querySelector('.agent-chip').getBoundingClientRect();return {x:r.x+10,y:r.y+10}})()");
    const frames = [];
    for (let i = 0; i < 24; i++) {
      if (i === 6) win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
      if (i === 18) win.webContents.sendInputEvent({ type: 'mouseMove', x: 359, y: 1 });
      frames.push((await win.capturePage(undefined, { stayHidden: true })).toPNG());
      await sleep(80);
    }
    require('./evidence-gif.cjs')(path.join(out, 'hover-motion.gif'), frames);
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point }); await sleep(200);
    await shot('agents-hover');
    const buttons = await run("Array.from(document.querySelector('.agent-chip').querySelectorAll('button')).map(b=>({w:b.getBoundingClientRect().width, opacity:getComputedStyle(b).opacity}))");
    assert.ok(buttons.every(b => b.w > 0 && b.opacity === '1'));
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 359, y: 1 });
    await run("document.querySelector('.agent-chip').focus()"); await sleep(100);
    if (process.env.NEKKO_ASSERT_FIXED) assert.equal(await run("getComputedStyle(document.querySelector('.agent-chip-actions')).display"), 'flex');
    await run("document.querySelector('[title=\"Rename this chat\"]').click()"); await sleep(100);
    assert.ok(await run("!!document.querySelector('.agent-chip input')"));
    await win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Input.insertText', { text: 'Renamed agent' });
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'RETURN' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'RETURN' }); await sleep(100);
    assert.equal(await run('titleFixture.renamed'), 'Renamed agent');
    assert.equal(await run('titleFixture.opened'), 0);
    await run("document.querySelector('[aria-label=\"Complete Renamed agent\"]').click()"); await sleep(300);
    assert.equal(await run('titleFixture.completed'), 1);
    assert.equal(await run('titleFixture.opened'), 0);
    if (process.env.NEKKO_ASSERT_FIXED) {
      await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true });
      await win.webContents.debugger.sendCommand('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
      await run('document.activeElement.blur()');
      assert.equal(await run("matchMedia('(pointer: coarse)').matches"), true);
      assert.equal(await run("getComputedStyle(document.querySelector('.agent-chip-actions')).display"), 'flex');
      await sleep(200);
      assert.ok(await run("document.querySelector('.agent-chip-actions').getBoundingClientRect().width > 0"));
      assert.equal(await run("getComputedStyle(document.querySelector('.agent-chip time')).display"), 'none');
    }
    win.webContents.debugger.detach();
    assert.equal(win.isVisible(), false);
    report.interactions = 'hover controls, keyboard focus, rename and complete without opening chat' + (process.env.NEKKO_ASSERT_FIXED ? '; emulated touch controls' : '');
  } catch (error) { report.errors.push(String(error.stack || error)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  win.destroy(); app.exit(report.errors.length ? 1 : 0);
});
