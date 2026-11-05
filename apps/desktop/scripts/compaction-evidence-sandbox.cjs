// Isolated component evidence. No bridge, real data, network or visible window.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
app.setPath('sessionData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1000, height: 650, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -5000, y: -5000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const report = { errors: [], captures: [] };
  win.on('show', () => report.errors.push('Window became visible'));
  win.on('focus', () => report.errors.push('Window took focus'));
  const run = s => win.webContents.executeJavaScript(s, true);
  const shot = async name => {
    await win.capturePage(undefined, { stayHidden: true }); await sleep(200);
    const file = path.join(out, name + '.png');
    fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG());
    report.captures.push(file);
  };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    await sleep(1000);
    for (const width of [1000, 390]) {
      win.setContentSize(width, 650); await sleep(300);
      const initial = await run("document.querySelector('[data-compaction] button').getAttribute('aria-expanded')");
      report['initial-' + width] = initial;
      await shot(width + '-initial');
      if (process.env.NEKKO_COMPACTION_AFTER) {
        assert.equal(initial, 'false');
        assert.equal(await run("document.body.textContent.includes('Goal and constraints')"), false);
        // DOM activation works without focusing an OS window.
        await run("document.querySelector('[data-compaction] button').click()");
        await sleep(250);
        assert.equal(await run("document.querySelector('[data-compaction] button').getAttribute('aria-expanded')"), 'true');
        assert.equal(await run("document.body.textContent.includes('Goal and constraints')"), true);
        await shot(width + '-expanded');
        await run("document.querySelector('[data-compaction] button').click()"); await sleep(200);
        assert.equal(await run("document.querySelector('[data-compaction] button').getAttribute('aria-expanded')"), 'false');
        assert.equal(await run('document.documentElement.scrollWidth <= innerWidth'), true);
        // Emulate document focus in this hidden renderer only, never OS focus.
        // Native input exercises the button's Enter/Space defaults, not .click().
        if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3');
        await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
        await run("document.querySelector('[data-compaction] button').focus()");
        assert.equal(await run("document.activeElement === document.querySelector('[data-compaction] button')"), true);
        const frames = [];
        for (const [key, code, windowsVirtualKeyCode, text] of [['Enter', 'Enter', 13, '\r'], [' ', 'Space', 32, ' ']]) {
          for (const expected of ['true', 'false']) {
            await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, text });
            await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode });
            await sleep(150);
            assert.equal(await run("document.querySelector('[data-compaction] button').getAttribute('aria-expanded')"), expected);
            assert.equal(await run("document.body.textContent.includes('Goal and constraints')"), expected === 'true');
            assert.equal(await run("document.getElementById(document.querySelector('[data-compaction] button').getAttribute('aria-controls')).hidden"), expected !== 'true');
            frames.push((await win.capturePage(undefined, { stayHidden: true })).resize({ width: Math.min(width, 700) }).toPNG());
            assert.equal(win.isVisible(), false); assert.equal(win.isFocused(), false);
          }
          report['keyboard-' + width + '-' + code] = 'expanded and collapsed using native input';
        }
        const recording = path.join(out, width + '-keyboard-toggle.gif');
        require('./evidence-gif.cjs')(recording, frames, 45);
        report.captures.push(recording);
        await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: false });
      }
    }
    assert.equal(win.isVisible(), false); assert.equal(win.isFocused(), false);
    assert.deepEqual(report.errors, []);
    report.success = true;
  } catch (e) { report.errors.push(String(e.stack || e)); report.success = false; }
  finally {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2)); win.destroy(); app.exit(report.success ? 0 : 1);
  }
});
