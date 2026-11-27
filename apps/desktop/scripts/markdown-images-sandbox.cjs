// Launch with layout-evidence-integration.cjs and NEKKO_LAYOUT_FIXTURE=markdown-images-fixture.tsx.
// NEKKO_MARKDOWN_IMAGES_BASELINE=1 captures the unchanged origin/main renderer.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
const profile = path.join(out, 'profile');
app.setPath('userData', profile);
app.setPath('sessionData', profile);
const base = process.env.NEKKO_MARKDOWN_IMAGES_BASELINE === '1';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = { checks: [], captures: [], errors: [], network: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest(({ url }, done) => {
    const cancel = !/^(file:|data:|blob:|devtools:)/.test(url);
    if (cancel) report.network.push(url);
    done({ cancel });
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, done) => done(false));
  const win = new BrowserWindow({ title: 'Markdown preview verification (isolated)', x: -5000, y: -2000, width: 820, height: 560, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('Window took focus'));
  const run = (code) => win.webContents.executeJavaScript(code);
  const check = async (name, expression) => {
    for (let i = 0; i < 80; i++) {
      if (await run(expression)) { report.checks.push(name); return; }
      await sleep(50);
    }
    throw Error(name);
  };
  const capture = async (name) => {
    const target = path.join(out, `${name}.png`);
    await sleep(200);
    fs.writeFileSync(target, (await win.capturePage(undefined, { stayHidden: true })).toPNG());
    report.captures.push(target);
  };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    await win.webContents.insertCSS('*,*::before,*::after{animation:none!important;transition:none!important}');
    await run(`void Object.assign(window, {
      card: name => document.querySelector('[data-remote-image$="/' + name + '.png"]'),
      toggle: () => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Auto-load images'),
      good: name => card(name)?.querySelector('img')?.naturalWidth > 0,
      fallback: name => card(name)?.querySelector('button')?.textContent.trim() === 'Load image' && card(name).textContent.replace(/\\s+/g, ' ').trim() === 'Load imageFrom images.example.com',
    })`);
    await check('Opened actual Markdown file preview', `!!document.querySelector('.md-doc') && !!card('current')`);
    if (base) {
      await check('Old explanation is shown without any fetch', `card('current').textContent.includes('Not from a search or page') && fixture.calls.length === 0`);
      await capture('markdown-preview-before-3579');
    } else {
      await check('Auto-load is on by default; image decodes; failed image has button and source only', `toggle()?.getAttribute('aria-pressed') === 'true' && good('current') && fallback('missing') && fixture.calls.length === 2`);
      await capture('markdown-preview-after-3579');
      await run(`card('missing').querySelector('button').click()`);
      await check('Load image retries a failed fetch and displays the image', `good('missing') && fixture.calls.length === 3`);
      await run(`toggle().click(); fixture.open('next-report')`);
      await check('Opt-out persists when opening another preview and makes no automatic requests', `toggle()?.getAttribute('aria-pressed') === 'false' && fallback('current') && fallback('missing') && fixture.calls.length === 3`);
      await capture('markdown-preview-manual-3579');
      await run(`fixture.chat()`);
      await check('Trusted chat photo loads but a model-only URL waits for a click', `good('trusted') && fallback('model') && fixture.calls.length === 4`);
    }
    report.window = { bounds: win.getBounds(), visible: win.isVisible(), focused: win.isFocused() };
    assert(!report.window.visible && !report.window.focused);
    assert.deepEqual(report.network, []);
  } catch (e) { report.errors.push(String(e.stack || e)); }
  finally {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    win.destroy(); app.exit(report.errors.length ? 1 : 0);
  }
});
