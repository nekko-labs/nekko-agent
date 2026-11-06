// Real renderer, synthetic data, hidden window and disposable profile. No host access.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
app.on('window-all-closed', () => {});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { checks: [], errors: [] };
const baseline = !!process.env.NEKKO_HOVER_BASELINE;
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  let win;
  try {
    for (const [width, orientation] of [[1440, 'vertical'], [1440, 'horizontal'], [460, 'horizontal'], [460, 'vertical']]) {
      const label = `${width}-${orientation}`;
      win = new BrowserWindow({ width, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
      const run = s => win.webContents.executeJavaScript(s, true);
      const shot = async name => fs.writeFileSync(path.join(out, `${name}.png`), (await win.capturePage(undefined, { stayHidden: true })).toPNG());
      await win.loadFile(path.join(out, 'index.html'));
      for (let i = 0; i < 80 && !await run("!!document.querySelector('.agent-chip-chat')"); i++) await sleep(100);
      await sleep(800);
      await run("(async () => { const settings = await window.nekko.updateSettings({firstPromptIntroSeen:true,showTips:false}); layoutFixture.store.setState({settings}); })()");
      await run(`(() => {
        const toggle = document.querySelector('[aria-label="Open agent list"]');
        if (toggle && toggle.getBoundingClientRect().width) toggle.click();
        document.querySelector('.agent-chip-chat').click();
      })()`);
      await sleep(700);
      // Dismiss the synthetic app's first-use tours, not any user window.
      for (let i = 0; i < 4; i++) {
        await run("document.querySelector('[role=dialog] [aria-label=Close]')?.click()");
        await sleep(350);
      }
      await run(`(() => { const toggle = document.querySelector('[aria-label="Open agent list"]'); if (toggle && toggle.getBoundingClientRect().width) toggle.click(); })()`);
      await sleep(300);
      await run(orientation === 'horizontal'
        ? "document.querySelector('[aria-label=\"Show agents in a row\"]')?.click()"
        : "document.querySelector('[aria-label=\"Show agents in a column\"]')?.click()");
      await sleep(500);
      await run("document.querySelector('[aria-label=\"Open agent list\"][aria-expanded=false]')?.click()");
      await sleep(300);
      const metrics = () => run(`(() => {
        const rows = [...document.querySelectorAll('.agent-chip-chat')];
        return rows.map(e => { const s = getComputedStyle(e), r = e.getBoundingClientRect(); return { title: e.title, active: e.hasAttribute('data-agent-active'), hover: e.matches(':hover'), background: s.backgroundColor, shadow: s.boxShadow, transition: s.transitionDuration, outline: s.outlineStyle, x: r.x, y: r.y, width: r.width, height: r.height }; });
      })()`);
      if (orientation === 'horizontal') await run("document.querySelectorAll('.agent-chip-chat')[1].scrollIntoView({block:'nearest',inline:'nearest'})");
      await sleep(200);
      const resting = await metrics();
      assert(resting.length >= 2, 'Need two real rows');
      const target = resting.find(r => !r.active && r.width > 0);
      assert(target && target.y < 900, 'Hover target must be visible');
      const hover = () => win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(target.x + target.width / 2), y: Math.round(target.y + target.height / 2) });
      hover();
      await sleep(200);
      const hovered = await metrics();
      const h = hovered.find(r => r.title === target.title);
      report.hit = await run("(() => { const r=document.querySelectorAll('.agent-chip-chat')[1].getBoundingClientRect(); return document.elementFromPoint(Math.round(r.x+r.width/2),Math.round(r.y+r.height/2))?.outerHTML.slice(0,1000); })()");
      report.target = target;
      if (!h.hover && width === 460 && orientation === 'vertical' && report.hit?.includes('clean-start')) {
        await shot(`drawer-occluded-${label}`);
        report.checks.push({ width, orientation, limitation: 'Existing narrow drawer is covered by chat wall (#1909)', hit: report.hit });
        win.destroy(); win = null; continue;
      }
      assert(h.hover, 'Real pointer must hover row');
      if (!baseline) {
        assert.notEqual(h.background, target.background, 'Hover changes background');
        assert.notEqual(h.shadow, 'none', 'Hover has glow');
        assert.equal(h.transition, '0.12s, 0.12s');
        assert.deepEqual(hovered.map(r => r.active), resting.map(r => r.active), 'Hover does not select');
        assert.equal(h.height, target.height, 'No layout movement');
      }
      await shot(`hover-${label}`);
      win.webContents.sendInputEvent({ type: 'mouseMove', x: width - 2, y: 898 });
      await sleep(200);
      const left = await metrics();
      if (!baseline) assert.equal(left.find(r => r.title === target.title).background, target.background, 'Leave restores background');
      if (width === 1440 && orientation === 'vertical') {
        const frames = path.join(out, 'motion'); fs.mkdirSync(frames, { recursive: true });
        for (let i = 0; i < 48; i++) {
          if (i === 8 || i === 32) hover();
          if (i === 20 || i === 44) win.webContents.sendInputEvent({ type: 'mouseMove', x: width - 2, y: 898 });
          fs.writeFileSync(path.join(frames, `${String(i).padStart(3, '0')}.png`), (await win.capturePage({ x: Math.max(0, Math.floor(target.x - 12)), y: 50, width: Math.ceil(target.width + 24), height: 450 }, { stayHidden: true })).toPNG());
          await sleep(35);
        }
      }
      hover();
      for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, x: Math.round(target.x + target.width / 2), y: Math.round(target.y + target.height / 2) });
      await sleep(300);
      const selected = (await metrics()).find(r => r.title === target.title);
      assert(selected.active, 'Click still selects the hovered chat');
      if (!baseline) assert.notEqual(selected.background, h.background, 'Selected hover stays stronger');
      win.webContents.sendInputEvent({ type: 'mouseMove', x: width - 2, y: 898 });
      await sleep(200);
      assert.notEqual((await metrics()).find(r => r.title === target.title).background, 'rgba(0, 0, 0, 0)', 'Selected row stays highlighted after leaving');
      // Emulate document focus without focusing a native window.
      win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
      // Keyboard modality, then focus the same row without a pointer hover.
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
      await run("document.querySelectorAll('.agent-chip-chat')[1].focus()");
      await sleep(200);
      const focused = await run("(() => {const e=document.activeElement,s=getComputedStyle(e); return {visible:e.matches(':focus-visible'),outline:s.outlineStyle,shadow:s.boxShadow};})()");
      report.focused = focused;
      assert(focused.visible && focused.outline === 'solid', 'Keyboard focus remains visible');
      if (!baseline) assert.notEqual(focused.shadow, 'none');
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      const reduced = await metrics();
      if (!baseline) assert(reduced.every(r => r.transition === '0s'), 'Reduced motion disables transition');
      win.webContents.debugger.detach();
      assert(!win.isVisible() && !win.isFocusable() && !win.isFocused(), 'Fixture stays hidden/non-focusable');
      report.checks.push({ width, orientation, resting, hovered, focused, reducedMotion: reduced.map(r => r.transition), isolation: { visible: win.isVisible(), focused: win.isFocused(), bounds: win.getBounds() } });
      win.destroy(); win = null;
    }
  } catch (e) { report.errors.push(e.stack); }
  finally {
    if (win) win.destroy();
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    await session.defaultSession.closeAllConnections();
    app.exit(report.errors.length ? 1 : 0);
  }
});
