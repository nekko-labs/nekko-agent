// Full-App Library journey: synthetic bridge, isolated profile, no network or OS input.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const baseline = process.env.NEKKO_LIBRARY_BASELINE === '1';
// Escape characters JSON.stringify leaves raw before splicing into evaluated code.
const js = (v) => JSON.stringify(v).replace(/[<>/\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { checks: {}, errors: [], captures: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  win.on('focus', () => report.errors.push('Window took focus'));
  const run = source => win.webContents.executeJavaScript(source);
  const check = async (source, label) => { const ok = await run(source); report.checks[label] = ok; if (!ok) throw Error(label); };
  const shot = async name => { const file = path.join(out, `${name}.png`); fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(file); };
  const click = text => run(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${js(text)}); if (!b) throw Error('Missing control'); b.click(); })()`);
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 80 && !await run('!!window.layoutFixture'); i++) await sleep(100);
    await sleep(500);
    await run(`document.querySelector('.zones-intro button[aria-label="Close"]')?.click(); localStorage.removeItem('nekko.libraryIntroSeen'); layoutFixture.store.getState().setView('artifacts')`);
    await sleep(500);
    for (const theme of ['dark', 'light']) {
      await run(`layoutFixture.store.setState({ settings: {...layoutFixture.store.getState().settings, theme: '${theme}'} }); layoutFixture.store.getState().applyTheme()`);
      for (const [width, height, label] of [[1440, 900, 'desktop'], [430, 932, 'narrow']]) {
        win.setContentSize(width, height); await sleep(300);
        await shot(`${theme}-${label}-first-visit`);
        if (!baseline) await check(`document.querySelector('[data-library-intro]') !== null`, `${theme}-${label}-intro-visible`);
      }
    }
    if (!baseline) {
      await click('Explore Library'); await sleep(100);
      await check(`!document.querySelector('[role="dialog"]') && localStorage.getItem('nekko.libraryIntroSeen') === '1'`, 'dismissal-persisted');
      await run(`layoutFixture.store.getState().setView('command')`); await sleep(100);
      await run(`layoutFixture.store.getState().setView('artifacts')`); await sleep(150);
      await check(`!document.querySelector('[role="dialog"]')`, 'return-does-not-reopen');
      await click('Library guide'); await sleep(100);
      await check(`document.querySelector('[data-library-intro]') !== null`, 'guide-reopens');
      await run(`document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))`); await sleep(100);
      await check(`!document.querySelector('[role="dialog"]')`, 'escape-closes');
      await click('Library guide'); await sleep(100);
      await run(`document.querySelector('[aria-label="Close Library guide"]').click()`); await sleep(100);
      await check(`!document.querySelector('[role="dialog"]')`, 'close-button-closes');
      await click('Library guide'); await sleep(100);
      await run(`document.querySelector('[role="dialog"]').parentElement.click()`); await sleep(100);
      await check(`!document.querySelector('[role="dialog"]')`, 'scrim-closes');
      await run(`location.reload()`); await sleep(1200);
      await run(`layoutFixture.store.getState().setView('artifacts')`); await sleep(150);
      await check(`!document.querySelector('[role="dialog"]')`, 'reload-keeps-dismissal');
    }
    // Identical synthetic document, backed by the existing FilePane contract.
    await run(`(() => { const f = layoutFixture, s = f.records[0]; s.messages = [{id:'request', role:'user', content:'Create a report', createdAt:Date.now()-1000}, {id:'doc', role:'assistant', content:'[Quarterly report](/reports/quarterly.md)', createdAt:Date.now()}]; f.putCachedSession(s); f.bridge.listComments = async () => []; f.bridge.readFile = async () => ({content:'# Quarterly report\\n\\nSynthetic report for Library verification.', truncated:false, binary:false}); f.bridge.openPath = async p => { f.lastOpenPath = p; }; f.store.getState().refreshSessions(); })()`);
    await sleep(300);
    if (!baseline) {
      await check(`!!document.querySelector('[data-artifact-kind] button')`, 'file-index-populated');
      await run(`(() => { const input = document.querySelector('[aria-label="Filter Library"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'no-match'); input.dispatchEvent(new Event('input', {bubbles:true})); })()`); await sleep(100);
      await check(`!document.querySelector('[data-artifact-kind]') && document.body.innerText.includes('Nothing matches.')`, 'filter-hides-nonmatches');
      await run(`(() => { const input = document.querySelector('[aria-label="Filter Library"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ''); input.dispatchEvent(new Event('input', {bubbles:true})); })()`); await sleep(100);
      await check(`!!document.querySelector('[data-artifact-kind] button')`, 'clear-filter-restores-file');
    }
    for (const theme of ['dark', 'light']) {
      await run(`layoutFixture.store.setState({settings:{...layoutFixture.store.getState().settings,theme:'${theme}'}}); layoutFixture.store.getState().applyTheme()`);
      for (const [width, height, label] of [[1440,900,'desktop'],[430,932,'narrow']]) {
        win.setContentSize(width,height); await sleep(200); await shot(`${theme}-${label}-library`);
      }
    }
    if (!baseline) {
      await run(`document.querySelector('[data-artifact-kind] button').click()`); await sleep(350);
      await check(`document.body.innerText.includes('Quarterly report') && [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Back to Library')`, 'narrow-preview-back-control');
      await shot('narrow-preview');
      await click('Open file');
      await check(`layoutFixture.lastOpenPath === '/reports/quarterly.md'`, 'open-file-exact-path');
      await click('Back to Library'); await sleep(100);
      await check(`!!document.querySelector('[data-artifact-kind]') && ![...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Open file')`, 'back-restores-list');
      await run(`document.querySelector('[data-artifact-kind] button').click()`); await sleep(100);
      await click('Open chat'); await sleep(200);
      await check(`layoutFixture.store.getState().view === 'command' && layoutFixture.store.getState().activeSessionId === 'a'`, 'source-chat-opens');
    }
    if (report.errors.length) throw Error('Renderer errors: ' + report.errors.join('; '));
    report.background = { visible: win.isVisible(), focusable: win.isFocusable(), bounds: win.getBounds() };
    if (report.background.visible || report.background.focusable) throw Error('Unsafe fixture window');
  } catch (error) { report.failure = String(error.stack || error); process.exitCode = 1; }
  finally { fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); win.destroy(); app.exit(process.exitCode || 0); }
});
