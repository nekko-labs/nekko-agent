// Full-App Library sync journey (#2748): synthetic bridge, isolated profile, hidden, off-screen,
// non-focusable window, no network or OS input. The engine is stood in for by the bridge's
// cloudStatus / onCloudStatus / librarySync, so each sync state can be shown and checked.
// Launch: NEKKO_LAYOUT_SANDBOX=library-sync-sandbox.cjs node layout-evidence-integration.cjs
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const js = (v) => JSON.stringify(v).replace(/[<>/]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { checks: {}, errors: [], captures: [], reported: null };

// Two chats' files, and one file from another computer.
const FILES = {
  a: [['Pricing page draft', '/work/site/pricing.html'], ['Beta readiness', '/work/reports/beta-readiness.md'], ['Security review', '/work/reports/security-review.md'], ['Model benchmarks', '/work/data/bench.csv']],
  b: [['Mascot poses', '/work/art/poses.png'], ['Board update', '/work/office/board-q4.pptx'], ['Install guide', '/work/notes/install.md']],
};
const STATES = {
  '/work/site/pricing.html': 'synced', '/work/reports/beta-readiness.md': 'synced', '/work/reports/security-review.md': 'syncing',
  '/work/data/bench.csv': 'tooLarge', '/work/art/poses.png': 'synced', '/work/office/board-q4.pptx': 'pending',
};
const REMOTE = { id: 'o1', deviceId: 'd2', device: 'Studio iMac', path: '/data/cloud/library/k1/roadmap.md', originalPath: '/Users/p/notes/roadmap.md', title: 'Roadmap', kind: 'doc', chat: 'Planning', modifiedAt: Date.now() - 3600000, size: 120 };
const status = (library) => ({ signedIn: true, account: { email: 'p@example.com', plan: 'pro', canSync: true, features: { libraryCloud: !!library } }, oauthPending: false, keysStoredIn: 'test', library, sync: { phase: 'idle', enabled: true } });

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  win.on('focus', () => report.errors.push('Window took focus'));
  const run = source => win.webContents.executeJavaScript(source);
  const check = async (source, label) => { const ok = await run(source); report.checks[label] = ok; if (!ok) throw Error(label); };
  const shot = async name => { const file = path.join(out, `${name}.png`); fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(file); };
  const radio = (group, name) => run(`(() => { const g = [...document.querySelectorAll('[role="radiogroup"]')].find(g => g.getAttribute('aria-label') === ${js(group)}); const b = [...g.querySelectorAll('[role="radio"]')].find(b => (b.getAttribute('aria-label') || b.textContent).trim().startsWith(${js(name)})); if (!b) throw Error('Missing control'); b.click(); })()`);
  const reopen = async () => { await run(`layoutFixture.store.getState().setView('command')`); await sleep(150); await run(`layoutFixture.store.getState().setView('artifacts')`); await sleep(1500); };
  // The engine's status as the bridge answers it, and pushed to the open page.
  const setCloud = (library) => run(`(() => { const s = ${js(status(library))}; layoutFixture.cloud = s; layoutFixture.cloudListeners.forEach(cb => cb(s)); })()`);
  const glyph = (title) => `[...document.querySelectorAll('[data-library-tile]')].find(t => t.textContent.includes(${js(title)}))?.querySelector('.library-live > [data-library-sync]')?.dataset.librarySync`;
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 80 && !await run('!!window.layoutFixture'); i++) await sleep(100);
    await sleep(500);
    await run(`(() => {
      document.querySelector('.zones-intro button[aria-label="Close"]')?.click();
      localStorage.setItem('nekko.libraryIntroSeen', '1');
      localStorage.removeItem('nekko.libraryLayout'); localStorage.removeItem('nekko.libraryCollapsed');
      const f = layoutFixture, files = ${js(FILES)}, now = Date.now();
      f.records.slice(0, 2).forEach((s, n) => {
        const list = files['ab'[n]];
        s.title = n ? 'Launch assets' : 'Pricing work';
        s.messages = [{ id: 'q' + n, role: 'user', content: 'Make these', createdAt: now - 100000 * (n + 1) }];
        list.forEach(([title, p], i) => s.messages.push({ id: s.id + i, role: 'assistant', content: '[' + title + '](' + p + ')', createdAt: now - 100000 * n - 3600000 * 6 * i }));
        s.updatedAt = now - n; f.putCachedSession(s);
      });
      f.records.slice(2).forEach((s) => { s.messages = []; f.putCachedSession(s); });
      f.bridge.listComments = async () => [];
      f.bridge.listDir = async () => { throw Error('no folders here'); };
      f.bridge.readFile = async (p) => ({ content: '# ' + p.split('/').pop() + '\\n\\nSynthetic file for Library verification.', truncated: false, binary: false });
      f.bridge.openPath = async p => { f.lastOpenPath = p; };
      // The engine: no Library sync until the journey says so.
      f.cloud = null; f.cloudListeners = []; f.reported = [];
      f.bridge.cloudStatus = async () => f.cloud;
      f.bridge.onCloudStatus = (cb) => { f.cloudListeners.push(cb); return () => { f.cloudListeners = f.cloudListeners.filter(x => x !== cb); }; };
      f.bridge.librarySync = async (files) => { f.reported.push(files); return f.cloud; };
      f.store.setState({ settings: { ...f.store.getState().settings, theme: 'dark' } }); f.store.getState().applyTheme();
      f.store.getState().refreshSessions();
    })()`);
    win.setContentSize(1440, 900); await reopen();

    // Not open to this account (no plan or switch): no clouds, no summary, the engine is told nothing.
    await check(`document.querySelectorAll('[data-artifact-row]').length >= 6`, 'files-listed');
    await check(`!document.querySelector('[data-library-sync]') && !document.querySelector('[data-library-sync-summary]') && layoutFixture.reported.length === 0`, 'no-trace-when-library-sync-is-not-open');
    await shot('sync-not-open');

    // Open, and on: the engine is told every file; each tile gets its cloud in the corner.
    await setCloud({ on: true, files: STATES, remote: [REMOTE] }); await sleep(1500);
    report.reported = await run('layoutFixture.reported.at(-1)');
    await check(`(() => { const r = layoutFixture.reported.at(-1) || []; const paths = r.map(f => f.path).sort().join(); return paths === ${js([...FILES.a, ...FILES.b].map(([, p]) => p).sort().join())} && r.find(f => f.path === '/work/site/pricing.html').chat === 'Pricing work'; })()`, 'engine-told-every-local-file-and-not-the-remote-one');
    await check(`${glyph('Pricing page draft')} === 'synced' && ${glyph('Security review')} === 'syncing' && ${glyph('Model benchmarks')} === 'tooLarge' && ${glyph('Board update')} === 'pending' && ${glyph('Install guide')} === 'pending'`, 'each-tile-shows-its-state');
    await check(`(() => { const t = [...document.querySelectorAll('[data-library-tile]')].find(t => t.textContent.includes('Pricing page draft')); const p = t.querySelector('.library-live').getBoundingClientRect(), g = t.querySelector('[data-library-sync]').getBoundingClientRect(); return p.right - g.right < 12 && g.top - p.top < 12 && g.width > 10; })()`, 'cloud-sits-in-the-top-right-corner');
    await check(`[...document.querySelectorAll('[data-library-tile]')].find(t => t.textContent.includes('Pricing page draft')).querySelector('[data-library-sync]').getAttribute('aria-label') === 'Backed up to Nekko Cloud'`, 'cloud-says-what-it-means');
    await check(`document.querySelector('[data-library-sync-summary]')?.textContent.trim() === 'Backing up 1 file'`, 'header-says-what-is-happening');
    // Another computer's file is listed under that computer, with a down-arrow cloud.
    await check(`(() => { const t = [...document.querySelectorAll('[data-library-tile]')].find(t => t.textContent.includes('Roadmap')); return !!t && t.textContent.includes('From Studio iMac') && t.querySelector('[data-library-sync]').dataset.librarySync === 'remote'; })()`, 'another-computers-file-is-listed-under-it');
    await check(`[...document.querySelectorAll('[data-artifact-row]')].every(r => !!r.querySelector('[data-library-sync]'))`, 'every-row-has-its-cloud');
    await shot('sync-large');
    await radio('Layout', 'Small icons'); await sleep(700); await shot('sync-small');
    await check(`(() => { const t = document.querySelector('[data-library-tile]'); const p = t.querySelector('.library-live').getBoundingClientRect(), g = t.querySelector('[data-library-sync]').getBoundingClientRect(); return g.right <= p.right + 1 && g.top >= p.top - 1 && g.width <= 19; })()`, 'small-icons-keep-a-smaller-cloud-inside-the-icon');
    await radio('Layout', 'Full cards'); await sleep(700); await shot('sync-cards');
    await radio('Layout', 'List'); await sleep(700); await shot('sync-list');
    await radio('Layout', 'Large icons'); await sleep(700);

    // Everything backed up.
    await setCloud({ on: true, files: Object.fromEntries([...FILES.a, ...FILES.b].map(([, p]) => [p, 'synced'])), remote: [REMOTE] }); await sleep(500);
    await check(`document.querySelector('[data-library-sync-summary]')?.dataset.librarySyncSummary === 'success' && document.querySelector('[data-library-sync-summary]').textContent.trim() === 'Backed up'`, 'header-says-backed-up');
    await check(`[...document.querySelectorAll('[data-library-tile] .library-live > [data-library-sync]')].filter(g => g.dataset.librarySync !== 'remote').every(g => g.dataset.librarySync === 'synced')`, 'every-local-tile-backed-up');
    await shot('sync-all-backed-up');

    // Another computer's file opens read-only, from its copy.
    await run(`[...document.querySelectorAll('[data-library-tile] button')].find(b => b.textContent.includes('Roadmap')).click()`); await sleep(900);
    await check(`!!document.querySelector('[data-library-back]') && document.querySelector('[data-library-back]').parentElement.textContent.includes('/data/cloud/library/k1/roadmap.md') && !!document.querySelector('[data-file-read-only]')`, 'another-computers-file-opens-read-only');
    await check(`![...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Open chat')`, 'no-open-chat-for-another-computers-file');
    await shot('sync-remote-open');
    await run(`document.querySelector('[data-library-back]').click()`); await sleep(500);

    // Sync off on this computer: every cloud is disconnected and the header says so.
    await setCloud({ on: false, files: Object.fromEntries([...FILES.a, ...FILES.b].map(([, p]) => [p, 'off'])), remote: [] }); await sleep(600);
    await check(`[...document.querySelectorAll('[data-library-tile] .library-live > [data-library-sync]')].every(g => g.dataset.librarySync === 'off') && document.querySelector('[data-library-sync-summary]').textContent.trim() === 'Not backed up'`, 'sync-off-shows-disconnected-clouds');
    await check(`![...document.querySelectorAll('[data-library-tile]')].some(t => t.textContent.includes('Roadmap'))`, 'remote-files-leave-with-their-copies');
    await shot('sync-off');

    // Light theme, mixed states again.
    await setCloud({ on: true, files: STATES, remote: [REMOTE] }); await sleep(400);
    await run(`(() => { const f = layoutFixture; f.store.setState({ settings: { ...f.store.getState().settings, theme: 'light' } }); f.store.getState().applyTheme(); })()`); await sleep(600);
    await shot('sync-light');
    win.setContentSize(430, 932); await sleep(500);
    await check(`[...document.querySelectorAll('[data-artifact-row]')].every(r => !!r.querySelector('[data-library-sync]'))`, 'narrow-rows-keep-their-clouds');
    await shot('sync-narrow');

    if (report.errors.length) throw Error('Renderer errors: ' + report.errors.join('; '));
    report.background = { visible: win.isVisible(), focusable: win.isFocusable(), bounds: win.getBounds() };
    if (report.background.visible || report.background.focusable) throw Error('Unsafe fixture window');
  } catch (error) { report.failure = String(error.stack || error); process.exitCode = 1; }
  finally { fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); win.destroy(); app.exit(process.exitCode || 0); }
});
