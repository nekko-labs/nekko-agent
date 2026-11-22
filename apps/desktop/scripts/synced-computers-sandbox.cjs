// Full-App journey for chats and Library files from other computers through Nekko Cloud
// (#3143, #3144): the Agents panel names each chat's computer and groups by computer, a copy's
// composer is read-only with Continue here, and Library names and groups files by computer.
// Synthetic bridge, isolated profile, hidden, off-screen, non-focusable window, no network or
// OS input. NEKKO_SYNCED_BASELINE=1 captures the same data on an unchanged checkout (via
// NEKKO_TEST_SOURCE) without the checks.
// Launch: NEKKO_LAYOUT_SANDBOX=synced-computers-sandbox.cjs node layout-evidence-integration.cjs
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const baseline = process.env.NEKKO_SYNCED_BASELINE === '1';
// Escape characters JSON.stringify leaves raw before splicing into evaluated code.
const js = (v) => JSON.stringify(v).replace(/[<>/\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { checks: {}, errors: [], captures: [], steps: [] };
const save = (step) => { report.steps.push(step); fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); };

const LAPTOP = { deviceId: 'dev-laptop', device: 'Laptop' };
const STUDIO = { deviceId: 'dev-studio', device: 'Studio iMac' };
// Four chats: one of this computer's, two of the Laptop's and one of the Studio iMac's.
const CHATS = [
  { title: 'Pricing page draft', link: ['Pricing page', '/work/site/pricing.html'] },
  { title: 'Trip planning notes', home: LAPTOP, link: ['Kyoto itinerary', '/Users/p/notes/kyoto.md'] },
  { title: 'Quarterly board update', home: STUDIO },
  { title: 'Fix the flaky upload test', home: LAPTOP },
];
const REMOTE = [
  { id: 'o1', deviceId: 'dev-laptop', device: 'Laptop', path: '/data/cloud/library/k1/kyoto.md', originalPath: '/Users/p/notes/kyoto.md', title: 'Kyoto itinerary', kind: 'doc', chat: 'Trip planning notes', modifiedAt: Date.now() - 3600000, size: 120 },
  { id: 'o2', deviceId: 'dev-studio', device: 'Studio iMac', path: '/data/cloud/library/k2/board.md', originalPath: '/Users/p/board/board.md', title: 'Board memo', kind: 'doc', chat: 'Quarterly board update', modifiedAt: Date.now() - 7200000, size: 300 },
];
const cloud = { signedIn: true, account: { email: 'p@example.com', plan: 'pro', canSync: true, features: { libraryCloud: true } }, oauthPending: false, keysStoredIn: 'test', library: { on: true, files: { '/work/site/pricing.html': 'synced', '/work/reports/beta.md': 'synced' }, remote: REMOTE }, sync: { phase: 'idle', enabled: true } };

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  win.on('focus', () => report.errors.push('Window took focus'));
  const run = source => { save(source.slice(0, 90)); return win.webContents.executeJavaScript(source); };
  const check = async (source, label) => { if (baseline) return; let ok = false; for (let i = 0; i < 15 && !ok; i++) { ok = await run(source); if (!ok) await sleep(200); } report.checks[label] = ok; if (!ok) throw Error(label); };
  const shot = async name => { const file = path.join(out, `${name}.png`); fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(file); };
  const click = async (selector) => { await run(`document.querySelector(${js(selector)})?.click()`); await sleep(350); };
  const clickText = async (selector, text) => { await run(`[...document.querySelectorAll(${js(selector)})].find(b => b.textContent.trim().startsWith(${js(text)}))?.click()`); await sleep(400); };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 80 && !await run('!!window.layoutFixture'); i++) await sleep(100);
    await sleep(500);
    await run(`(() => {
      localStorage.setItem('nekko.libraryIntroSeen', '1');
      for (const k of ['nekko.libraryLayout', 'nekko.libraryCollapsed', 'nekko.libraryGroupBy', 'nekko.libraryShowComputer']) localStorage.removeItem(k);
      const f = layoutFixture, chats = ${js(CHATS)}, now = Date.now();
      f.records.forEach((s, n) => {
        const c = chats[n];
        s.title = c.title; s.modelId = 'claude-opus-5-5';
        if (c.home) s.home = c.home; else delete s.home;
        s.messages = [
          { id: s.id + 'u', role: 'user', content: 'Work on: ' + c.title, createdAt: now - 600000 * (n + 1) },
          { id: s.id + 'a', role: 'assistant', content: c.link ? 'Done. See [' + c.link[0] + '](' + c.link[1] + ').' : 'Done.', createdAt: now - 600000 * n - 1000 },
        ];
        s.updatedAt = now - 600000 * n; f.putCachedSession(s);
      });
      f.bridge.listComments = async () => [];
      f.bridge.listDir = async () => { throw Error('no folders here'); };
      f.bridge.readFile = async (p) => ({ content: '# ' + p.split('/').pop() + '\\n\\nSynthetic file.', truncated: false, binary: false });
      f.bridge.forkSession = async (id) => { const src = f.records.find(s => s.id === id); const copy = { ...src, id: 'forked', title: 'Continued: ' + src.title }; delete copy.home; f.records.push(copy); f.putCachedSession(copy); f.forkedFrom = id; return copy; };
      f.cloud = ${js(cloud)}; f.cloudListeners = [];
      f.bridge.cloudStatus = async () => f.cloud;
      f.bridge.onCloudStatus = (cb) => { f.cloudListeners.push(cb); return () => {}; };
      f.bridge.librarySync = async () => f.cloud;
      f.store.setState({ settings: { ...f.store.getState().settings, theme: 'dark' } }); f.store.getState().applyTheme();
      f.store.getState().refreshSessions();
      f.store.getState().setView('command');
    })()`);
    await sleep(1500);
    for (let i = 0; i < 4; i++) { await run("document.querySelector('[aria-modal=true] [aria-label=Close]')?.click(); document.querySelector('.zones-intro button[aria-label=\"Close\"]')?.click()"); await sleep(250); }
    win.setContentSize(1440, 900); await sleep(400);

    // Each card names its computer in front of the model: the Laptop's and Studio's chats, and This Mac/PC for the rest.
    await shot('panel-cards');
    await check(`[...document.querySelectorAll('.agent-chip-chat [data-computer-chip="cloud:dev-laptop"]')].some(c => c.textContent.trim() === 'Laptop') && [...document.querySelectorAll('[data-computer-chip="cloud:dev-studio"]')].some(c => c.textContent.trim() === 'Studio iMac') && !!document.querySelector('[data-computer-chip="here"]')`, 'cards-name-their-computer');

    // The view menu offers Group by > Computer and Show > Computer once another computer has a chat here.
    await click('[data-agent-view-button]');
    await click('[data-view-menu-row="group"]');
    await shot('view-menu-group');
    await check(`[...document.querySelectorAll('[data-agent-view-submenu="group"] [role=menuitemradio]')].some(b => b.textContent.trim() === 'Computer')`, 'group-by-computer-offered');
    await clickText('[data-agent-view-submenu="group"] [role=menuitemradio]', 'Computer');
    await run("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))"); await sleep(200);
    await run("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))"); await sleep(400);
    await shot('panel-by-computer');
    await check(`(() => { const heads = [...document.querySelectorAll('.agent-panel-group-label')].map(h => h.textContent.trim()); return /^This (Mac|PC|computer)$/.test(heads[0]) && heads.includes('Laptop') && heads.includes('Studio iMac'); })()`, 'groups-by-computer');
    await check(`![...document.querySelectorAll('.agent-chip-chat [data-computer-chip]')].some(c => c.getClientRects().length > 0 && c.getBoundingClientRect().width > 0)`, 'grouped-cards-leave-the-computer-to-the-heading');

    // Show > Computer off hides the chip (back on Group by Status first).
    await click('[data-agent-view-button]');
    await click('[data-view-menu-row="group"]');
    await clickText('[data-agent-view-submenu="group"] [role=menuitemradio]', 'Activity');
    await click('[data-view-menu-row="show"]');
    await clickText('[data-agent-view-submenu="show"] [role=menuitemcheckbox]', 'Computer');
    await check(`![...document.querySelectorAll('.agent-chip-chat [data-computer-chip]')].some(c => c.getClientRects().length > 0 && c.getBoundingClientRect().width > 0)`, 'show-computer-off-hides-the-chip');
    await clickText('[data-agent-view-submenu="show"] [role=menuitemcheckbox]', 'Computer');
    await run("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))"); await sleep(200);
    await run("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))"); await sleep(300);

    // A Laptop chat opens read-only, with Continue here.
    await run(`[...document.querySelectorAll('.agent-chip-chat')].find(c => c.textContent.includes('Trip planning'))?.click()`); await sleep(2500);
    await check(`(document.querySelector('[data-computer-block="synced"]')?.textContent ?? '').includes('From Laptop, through Nekko Cloud. Read-only here')`, 'copy-says-where-it-is-from');
    await sleep(600);
    // The offscreen window does not advance a window's enter animation: settle it before the capture.
    await run('document.getAnimations().forEach(a => { try { a.finish(); } catch {} })'); await sleep(300);
    await shot('copy-composer');
    await check(`!document.querySelector('[data-sync-toggle]')`, 'copy-has-no-sync-switch');
    await click('[data-continue-here]'); await sleep(1200);
    await check(`layoutFixture.forkedFrom === layoutFixture.records[1].id`, 'continue-here-forks-the-copy');
    // The offscreen window does not advance a window's enter animation: settle it before the capture.
    await run('document.getAnimations().forEach(a => { try { a.finish(); } catch {} })'); await sleep(300);
    await shot('continued-here');

    // Library: files from the Laptop and the Studio iMac name their computer, and group by computer.
    await run(`layoutFixture.store.getState().setView('artifacts')`); await sleep(1800);
    await run(`layoutFixture.cloudListeners.forEach(cb => cb(layoutFixture.cloud))`); await sleep(1200);
    await shot('library-show-computer');
    await check(`[...document.querySelectorAll('.library-tile-meta')].some(m => /^This (Mac|PC|computer) · Pricing page draft/.test(m.textContent)) && [...document.querySelectorAll('.library-tile-meta')].some(m => m.textContent.startsWith('Laptop · Trip planning notes'))`, 'library-files-name-their-computer');
    // A synced copy's own links are the Laptop's files: Library lists them once, through Library sync, never as this computer's.
    await check(`![...document.querySelectorAll('.library-tile-meta')].some(m => /^This (Mac|PC|computer) · Trip planning notes/.test(m.textContent))`, 'a-copy-s-files-are-not-this-computer-s');
    await run(`(() => { const g = [...document.querySelectorAll('[role="radiogroup"]')].find(g => g.getAttribute('aria-label') === 'Group by'); [...(g?.querySelectorAll('[role="radio"]') ?? [])].find(b => (b.getAttribute('aria-label') || b.textContent).includes('omputer'))?.click(); })()`);
    await sleep(900);
    await shot('library-by-computer');
    await check(`(() => { const heads = [...document.querySelectorAll('[data-library-group] h2')].map(h => h.textContent.replace(/\\d+$/, '').trim()); return /^This (Mac|PC|computer)/.test(heads[0]) && heads.some(h => h.startsWith('Laptop')) && heads.some(h => h.startsWith('Studio iMac')); })()`, 'library-groups-by-computer');
    await check(`localStorage.getItem('nekko.libraryGroupBy') === 'computer'`, 'library-grouping-remembered');
  } catch (e) {
    report.errors.push(String(e && e.stack || e));
  } finally {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    win.destroy();
    app.exit(report.errors.length ? 1 : 0);
  }
});
