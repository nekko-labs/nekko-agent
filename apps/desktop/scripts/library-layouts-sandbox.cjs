// Full-App Library layouts journey: synthetic bridge, isolated profile, no network or OS input.
// NEKKO_LIBRARY_BASELINE=1 captures the same data on an unchanged checkout (via NEKKO_TEST_SOURCE).
// NEKKO_LIBRARY_MOTION=1 also records frames of each layout change, every animation slowed evenly by NEKKO_LIBRARY_SLOW (default 4).
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const baseline = process.env.NEKKO_LIBRARY_BASELINE === '1';
const motion = process.env.NEKKO_LIBRARY_MOTION === '1';
const slow = Number(process.env.NEKKO_LIBRARY_SLOW) || 4;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { checks: {}, errors: [], captures: [], frames: {} };

// Files of many kinds, linked from three chats, newest first. Diagram links are not indexed today, so 22 of the 25 list.
const FILES = {
  a: [['Pricing page draft', '/work/site/pricing.html'], ['Docs search demo', '/work/site/search-demo.html'], ['Release notes preview', '/work/site/release-0-9.html'], ['Onboarding flow', '/work/site/onboarding.htm'], ['Status dashboard', '/work/site/status.html'], ['Perf report', '/work/reports/perf-report.html'], ['Changelog page', '/work/site/changelog.html'], ['Engine architecture', '/work/notes/engine.mmd'], ['Model benchmarks', '/work/data/bench.csv']],
  b: [['Beta readiness', '/work/reports/beta-readiness.md'], ['Security review', '/work/reports/security-review.md'], ['Meeting notes', '/work/notes/notes-11-08.md'], ['Market scan', '/work/reports/market-scan.pdf'], ['Install guide', '/work/notes/install.md'], ['Board update', '/work/office/board-q4.pptx'], ['Budget', '/work/office/budget.xlsx'], ['Relay handshake', '/work/notes/relay.mermaid']],
  c: [['Library layouts', '/work/nekko-designs/library.html'], ['Rail icons', '/work/designs/rail-icons.svg'], ['Tray goodbye card', '/work/designs/goodbye.png'], ['Composer toolbar', '/work/mockups/toolbar.html'], ['Mascot poses', '/work/art/poses.png'], ['App icon', '/work/art/icon.webp'], ['Usage export', '/work/data/usage.csv'], ['Release pipeline', '/work/notes/pipeline.drawio']],
};

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  win.on('focus', () => report.errors.push('Window took focus'));
  const run = source => win.webContents.executeJavaScript(source);
  const check = async (source, label) => { const ok = await run(source); report.checks[label] = ok; if (!ok) throw Error(label); };
  const shot = async name => { const file = path.join(out, `${name}.png`); fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(file); };
  const radio = (group, name) => run(`(() => { const g = document.querySelector('[role="radiogroup"][aria-label="${group}"]'); const b = [...g.querySelectorAll('[role="radio"]')].find(b => (b.getAttribute('aria-label') || b.textContent).trim().startsWith(${JSON.stringify(name)})); if (!b) throw Error('Missing ${group} ' + ${JSON.stringify(name)}); b.click(); })()`);
  // Frames of one change, captured as fast as the window paints.
  const record = async (name, act, ms) => {
    const dir = path.join(out, 'frames', name); fs.mkdirSync(dir, { recursive: true });
    let i = 0; const write = async () => fs.writeFileSync(path.join(dir, `${String(i++).padStart(3, '0')}.png`), (await win.capturePage(undefined, { stayHidden: true })).toPNG());
    await write(); await write();
    await act(); const end = Date.now() + ms;
    while (Date.now() < end) await write();
    await write(); report.frames[name] = i;
  };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 80 && !await run('!!window.layoutFixture'); i++) await sleep(100);
    await sleep(500);
    await run(`(() => {
      document.querySelector('.zones-intro button[aria-label="Close"]')?.click();
      localStorage.setItem('nekko.libraryIntroSeen', '1');
      localStorage.removeItem('nekko.libraryLayout'); localStorage.removeItem('nekko.libraryCollapsed');
      const f = layoutFixture, files = ${JSON.stringify(FILES)}, now = Date.now();
      f.records.slice(0, 3).forEach((s, n) => {
        const list = files['abc'[n]];
        s.messages = [{ id: 'q' + n, role: 'user', content: 'Make these', createdAt: now - 100000 * (n + 1) }];
        list.forEach(([title, p], i) => s.messages.push({ id: s.id + i, role: 'assistant', content: '[' + title + '](' + p + ')', createdAt: now - 100000 * n - 3600000 * 6 * i }));
        s.updatedAt = now - n; f.putCachedSession(s);
      });
      f.bridge.listComments = async () => [];
      f.bridge.readFile = async (p) => ({ content: '# ' + p.split('/').pop() + '\\n\\nSynthetic file for Library verification.', truncated: false, binary: false });
      f.bridge.openPath = async p => { f.lastOpenPath = p; };
      f.store.setState({ settings: { ...f.store.getState().settings, workProfile: 'developer', theme: 'dark' } }); f.store.getState().applyTheme();
      f.store.getState().refreshSessions();
      f.store.getState().setView('artifacts');
    })()`);
    await sleep(900);
    win.setContentSize(1440, 900); await sleep(300);
    if (baseline) {
      await shot('desktop-default');
      win.setContentSize(430, 932); await sleep(300); await shot('narrow-default');
    } else {
      await check(`document.querySelectorAll('[data-artifact-row]').length === 22`, 'all-files-listed');
      await check(`document.querySelector('[data-library-layout]').dataset.libraryLayout === 'large' && !!document.querySelector('[data-library-canvas]')`, 'opens-on-large-previews');
      await check(`document.querySelector('[data-library-group]').dataset.libraryGroup === 'web' && document.querySelector('[data-artifact-kind]').dataset.artifactKind === 'web'`, 'developer-leads-with-web-pages');
      await check(`[...document.querySelectorAll('.library-fold')].every(f => f.hasAttribute('data-open'))`, 'groups-start-expanded');
      await check(`[...document.querySelector('[role="radiogroup"][aria-label="Show"]').querySelectorAll('[role="radio"]')].map(b => b.textContent.replace(/\\s+\\d+$/, '').trim()).join('|') === 'All|Web pages|Documents|Designs|Data|Office files|Images'`, 'type-slider-all-then-kinds');
      await shot('desktop-large');
      for (const [label, name] of [['Small icons', 'small'], ['Full cards', 'cards'], ['List', 'list']]) {
        await radio('Layout', label); await sleep(600);
        await check(`document.querySelector('[data-library-layout]').dataset.libraryLayout === '${name}' && localStorage.getItem('nekko.libraryLayout') === '${name}'`, `layout-${name}-saved`);
        await shot(`desktop-${name}`);
      }
      await check(`!document.querySelector('[data-library-canvas]') && document.querySelector('.library-list').getBoundingClientRect().width > 1000`, 'list-spans-the-page');
      await run(`document.querySelector('[data-artifact-row]').click()`); await sleep(600);
      await check(`document.querySelector('.library-list').getBoundingClientRect().width < 400 && !!document.querySelector('[aria-label="Close preview"]')`, 'list-preview-narrows-list');
      await shot('desktop-list-preview');
      await run(`document.querySelector('[aria-label="Close preview"]').click()`); await sleep(600);
      await check(`document.querySelector('.library-list').getBoundingClientRect().width > 1000`, 'closing-preview-widens-list');
      await radio('Layout', 'Large icons'); await sleep(600);
      await run(`document.querySelector('[data-library-group="web"] h2 button').click()`); await sleep(400);
      await check(`!document.querySelector('[data-library-group="web"] .library-fold').hasAttribute('data-open') && !document.querySelector('[data-artifact-kind="web"] .library-fold').hasAttribute('data-open') && JSON.parse(localStorage.getItem('nekko.libraryCollapsed')).includes('web')`, 'group-folds-and-is-remembered');
      await shot('desktop-web-folded');
      await run(`document.querySelector('[data-library-group="web"] h2 button').click()`); await sleep(400);
      await radio('Show', 'Documents'); await sleep(600);
      await check(`document.querySelectorAll('[data-library-group]').length === 1 && document.querySelectorAll('[data-library-tile]').length === 5 && !document.querySelector('[data-library-group] h2 button')`, 'kind-shows-only-that-kind');
      await shot('desktop-documents');
      await radio('Show', 'All'); await sleep(600);
      await run(`document.querySelector('[data-library-tile] button').click()`); await sleep(400);
      await check(`!!document.querySelector('[aria-label="Close preview"]') && !document.querySelector('[data-library-canvas]')`, 'tile-opens-preview');
      await shot('desktop-preview');
      await run(`document.querySelector('[aria-label="Close preview"]').click()`); await sleep(300);
      await check(`!!document.querySelector('[data-library-canvas]')`, 'close-returns-to-previews');
      win.setContentSize(430, 932); await sleep(400);
      await shot('narrow-default');
      await check(`!!document.querySelector('[data-artifact-row]') && !document.querySelector('[data-library-canvas]')?.offsetParent`, 'narrow-keeps-the-list');
      win.setContentSize(1440, 900); await sleep(400);
      if (motion) {
        // Slow every animation evenly (view transitions and CSS transitions alike) through DevTools.
        win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Animation.enable'); await win.webContents.debugger.sendCommand('Animation.setPlaybackRate', { playbackRate: 1 / slow });
        await record('large-to-small', () => radio('Layout', 'Small icons'), 340 * slow + 200);
        await record('small-to-cards', () => radio('Layout', 'Full cards'), 340 * slow + 200);
        await record('cards-to-list', () => radio('Layout', 'List'), 340 * slow + 200);
        await record('list-to-large', () => radio('Layout', 'Large icons'), 340 * slow + 200);
        await record('fold-web', () => run(`document.querySelector('[data-library-group="web"] h2 button').click()`), 240 * slow + 200);
        await record('show-documents', () => radio('Show', 'Documents'), 340 * slow + 200);
      }
    }
    if (report.errors.length) throw Error('Renderer errors: ' + report.errors.join('; '));
    report.background = { visible: win.isVisible(), focusable: win.isFocusable(), bounds: win.getBounds() };
    if (report.background.visible || report.background.focusable) throw Error('Unsafe fixture window');
  } catch (error) { report.failure = String(error.stack || error); process.exitCode = 1; }
  finally { fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); win.destroy(); app.exit(process.exitCode || 0); }
});
