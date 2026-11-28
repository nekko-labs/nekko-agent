// Run with layout-evidence-integration.cjs and the real renderer stylesheet.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
const before = process.env.NEKKO_COMPOSER_BEFORE === '1';
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1000, height: 760, useContentSize: true, x: -10000, y: -10000, show: false, focusable: false, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const run = script => win.webContents.executeJavaScript(script, true);
  const errors = [];
  win.on('focus', () => errors.push('Unexpected window focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') errors.push(e.message); });
  const editor = `document.querySelector('.composer-editor-wrap [contenteditable]')`;
  const dialog = `document.querySelector('[aria-label="Prompt suggestions"]')`;
  const chip = `document.querySelector('[data-prompt-suggestions]')`;
  const shot = async name => fs.writeFileSync(path.join(out, `${name}.png`), (await win.capturePage(undefined, { stayHidden: true })).toPNG());
  const report = { errors, layouts: [] };
  let failed = false;
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 60 && !await run('!!window.layoutFixture'); i++) await sleep(100);
    for (const width of [1000, 390]) for (const surface of ['window', 'full']) {
      win.setContentSize(width, 760);
      await run(`layoutFixture.showFolderComposer(false, true, ${JSON.stringify(surface)}, '')`);
      await sleep(350);
      const measure = () => run(`(() => { const e = ${editor}, s = getComputedStyle(e); return {height:e.clientHeight, line:parseFloat(s.lineHeight), top:parseFloat(s.paddingTop), bottom:parseFloat(s.paddingBottom), scroll:e.scrollHeight}; })()`);
      const empty = await measure();
      if (surface === 'window') await shot(`empty-${width}`);
      await run(`${editor}.focus(); document.execCommand('insertText', false, 'Fix the layout shift in the settings panel.')`);
      await sleep(250);
      await run(`${chip}.click()`);
      await sleep(240);
      if (surface === 'window') await shot(`suggestions-${width}`);
      const rendered = await run(`${dialog}.innerText`);
      if (!before) {
        assert.equal(empty.height, empty.line + empty.top + empty.bottom, `${surface}/${width}: one line`);
        assert.deepEqual([empty.top, empty.bottom], [8, 4]);
        assert.match(rendered, /Add context[\s\S]*Set boundaries[\s\S]*Ask for a check/);
        assert.doesNotMatch(rendered, /Suggested model|persona|parts/);
        await run(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
        assert.ok(await run(`!${dialog} && document.activeElement === ${chip}`));
        await run(`${chip}.click()`);
        await sleep(120);
        await run(`Array.from(${dialog}.querySelectorAll('button')).find(b => b.textContent.includes('Ask for a check')).click()`);
        await sleep(250);
        assert.match(await run(`${editor}.innerText`), /^Fix the layout shift[\s\S]*Verify the result/);
        assert.ok(await run(`!${dialog} && document.activeElement === ${editor} && !layoutFixture.lastSend`));
        assert.ok((await measure()).height > empty.height, 'Multiline draft grows');
        await run(`(() => { const e = ${editor}; e.setSelectionRange(0, e.value.length); const data = new DataTransfer(); data.setData('text/plain', ${JSON.stringify('Many lines\n'.repeat(75))}); e.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })); })()`);
        await sleep(200);
        const long = await measure();
        assert.ok(long.scroll > long.height && long.height < 380, `Long draft caps and scrolls: ${JSON.stringify(long)}`);
        await run(`document.execCommand('selectAll'); document.execCommand('delete')`);
        await sleep(200);
        assert.equal((await measure()).height, empty.height, 'Clearing restores resting height');
      }
      report.layouts.push({width, surface, empty, rendered});
    }
    assert.ok(!win.isVisible() && !win.isFocusable());
  } catch (error) { failed = true; report.failure = error.stack; }
  finally {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    win.destroy();
    app.exit(failed ? 1 : 0);
  }
});
