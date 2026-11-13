// Matched Library document/row evidence, full App in an isolated hidden window.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile-' + Date.now()));
const baseline = process.env.NEKKO_LIBRARY_BASELINE === '1';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { checks: {}, errors: [], captures: [] };
const files = [
  ['Landing report', '/work/reports/landing-report.md'],
  ['Library and first visit guide', '/work/reports/library-guide.markdown'],
  ['Release checklist', '/work/reports/checklist.txt'],
  ['Unreadable document', '/work/reports/unreadable.md'],
  ['Market scan (PDF)', '/work/reports/market-scan.pdf'],
  ['Raster sample', '/work/art/sample.png'],
  ['Vector sample', '/work/art/sample.svg'],
];
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('Window took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = source => win.webContents.executeJavaScript(source);
  const check = async (source, label) => { const value = await run(source); report.checks[label] = value; if (!value) throw Error(label); };
  const shot = async name => { const file = path.join(out, (baseline ? 'before-' : 'after-') + name + '.png'); fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(file); };
  const radio = async name => { await run(`(() => { const b = [...document.querySelectorAll('[role="radio"]')].find(b => (b.getAttribute('aria-label') || b.textContent).startsWith(${JSON.stringify(name)})); if (!b) throw Error('Missing ' + ${JSON.stringify(name)}); b.click(); })()`); await sleep(100); for (let i = 0; i < 100; i++) { if (await run(`!document.documentElement.dataset.libraryTransition`)) { await sleep(100); return; } await sleep(80); } throw Error('Library transition did not finish'); };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 80 && !await run('!!window.layoutFixture'); i++) await sleep(100);
    await run(`(() => {
      document.querySelector('.zones-intro button[aria-label="Close"]')?.click();
      localStorage.setItem('nekko.libraryIntroSeen', '1'); localStorage.setItem('nekko.libraryLayout', 'list'); localStorage.removeItem('nekko.libraryCollapsed');
      const f = layoutFixture, files = ${JSON.stringify(files)}, now = 1800000000000;
      f.reads = {}; f.bridge.listComments = async () => []; f.bridge.listWorkflows = async () => ({ workflows: [], runs: [] });
      f.bridge.listDir = async p => files.filter(x => x[1].startsWith(p + '/')).map(x => ({ name: x[1].split('/').pop(), path: x[1], isDir: false }));
      f.bridge.readFile = async p => {
        f.reads[p] = (f.reads[p] || 0) + 1;
        if (p.includes('unreadable')) throw Error('Fixture refused read');
        if (p.endsWith('.png')) { const c = document.createElement('canvas'); c.width = 1600; c.height = 900; const ctx = c.getContext('2d'); ctx.fillStyle = '#854f6c'; ctx.fillRect(0, 0, 1600, 900); f.originalImage = c.toDataURL('image/png'); return { content: '', binary: true, truncated: false, imageDataUrl: f.originalImage }; }
        if (p.endsWith('.svg')) return { content: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900"><rect width="1200" height="900" fill="#38bdf8"/></svg>', binary: false, truncated: false };
        const title = files.find(x => x[1] === p)?.[0] || 'Document';
        return { binary: false, truncated: false, content: p.endsWith('.txt')
          ? 'Release checklist\\n\\nConfirm the build and signed installers.\\nVerify the document previews.\\nCheck keyboard navigation.\\nPublish the release notes.\\n\\nOwner: Nekko Labs\\nStatus: Ready for review'
          : '# ' + title + '\\n\\nA focused summary of the changes, verification and next steps.\\n\\n## What changed\\n\\n- Document tiles show their contents.\\n- Row icons identify each file type.\\n- Thumbnail reads are shared and cached.\\n\\n## Verification\\n\\n| Check | Result |\\n| --- | --- |\\n| Focused tests | Passed |\\n| Offline rendering | Passed |\\n\\n## Next step\\n\\nReview the library and open the source file.' };
      };
      f.records.forEach((s, n) => { s.messages = n ? [] : files.map(([title, p], i) => ({ id: 'thumb-' + i, role: 'assistant', content: '[' + title + '](' + p + ')', createdAt: now - i * 1000 })); s.updatedAt = now - n; f.putCachedSession(s); });
      f.store.setState({ settings: { ...f.store.getState().settings, theme: 'dark', workProfile: 'writer' } }); f.store.getState().applyTheme();
      f.store.getState().setView('workflows');
    })()`);
    await sleep(150); await run(`(async () => { await layoutFixture.store.getState().refreshSessions(); layoutFixture.store.getState().setView('artifacts'); })()`); await sleep(500); await radio('Documents'); await radio('Full cards'); await sleep(1000);
    await shot('dark-cards');
    if (!baseline) {
      await check(`document.querySelectorAll('[data-live-preview="document"] img').length === 3`, 'three-document-content-previews');
      await check(`document.querySelectorAll('[data-library-file-icon]').length === 5`, 'compact-row-icons');
      await check(`document.querySelectorAll('[data-library-tile] svg[data-preview-kind]').length === 2`, 'unreadable-and-pdf-fallback');
      await check(`!document.querySelector('.library-live iframe')`, 'documents-use-no-live-frames');
      await check(`Object.entries(layoutFixture.reads).filter(([p]) => !p.includes('unreadable')).every(([, n]) => n === 1) && !layoutFixture.reads['/work/reports/market-scan.pdf']`, 'one-read-per-supported-file-no-pdf-read');
      report.coldReads = await run('({...layoutFixture.reads})');
      await check(`!layoutFixture.reads['/work/art/sample.png'] && !layoutFixture.reads['/work/art/sample.svg']`, 'hidden-image-kind-not-read');

      const motion = [];
      const recording = (async () => { for (let i = 0; i < 24; i++) { motion.push((await win.capturePage(undefined, { stayHidden: true })).resize({ width: 1008 }).toPNG()); await sleep(80); } })();
      await radio('Small icons'); await radio('Large icons'); await radio('Full cards'); await recording;
      require('./evidence-gif.cjs')(path.join(out, 'after-cached-layout-switches.gif'), motion, 8);
      await check(`Object.entries(layoutFixture.reads).filter(([p]) => !p.includes('unreadable')).every(([, n]) => n === 1)`, 'layout-changes-reuse-cache');
      await run(`layoutFixture.store.getState().setView('workflows')`); await sleep(200); await run(`layoutFixture.store.getState().setView('artifacts')`); await sleep(900);
      await check(`document.querySelectorAll('[data-live-preview="document"]').length === 3 && Object.entries(layoutFixture.reads).filter(([p]) => !p.includes('unreadable')).every(([, n]) => n === 1)`, 'return-to-library-reuses-cache');
      const rowPath = await run(`document.querySelector('[data-artifact-row]').title`);
      await run(`document.querySelector('[data-artifact-row]').click()`); await sleep(500);
      await check(`!!document.querySelector('[aria-label="Close preview"]')`, 'row-opens-source-preview');
      await run(`document.querySelector('[aria-label="Close preview"]').click()`); await sleep(500);
      report.openedPath = rowPath;
      await radio('Images'); await sleep(700);
      await check(`document.querySelectorAll('[data-live-preview="image"] img').length === 2 && [...document.querySelectorAll('[data-live-preview="image"] img')].every(img => img.complete && img.naturalWidth <= 640 && img.src.startsWith('data:image/webp'))`, 'raster-and-svg-resized-to-webp');
      report.images = await run(`[...document.querySelectorAll('[data-live-preview="image"] img')].map(img => ({ width: img.naturalWidth, height: img.naturalHeight, encodedChars: img.src.length }))`);
      report.originalImageChars = await run('layoutFixture.originalImage.length');
      await radio('Large icons'); await radio('Full cards');
      await check(`layoutFixture.reads['/work/art/sample.png'] === 1 && layoutFixture.reads['/work/art/sample.svg'] === 1`, 'image-layout-changes-reuse-cache');
      await radio('Documents');
      const previousReads = await run('({...layoutFixture.reads})');
      await run(`(async () => { const f = layoutFixture, s = f.records[0]; s.updatedAt++; f.putCachedSession(s); await f.store.getState().refreshSessions(); })()`); await sleep(700);
      await check(`layoutFixture.reads['/work/reports/library-guide.markdown'] === ${previousReads['/work/reports/library-guide.markdown'] + 1} && document.querySelectorAll('[data-live-preview="document"]').length === 3`, 'chat-revision-invalidates-document-cache');
    }
    await run(`layoutFixture.store.setState({ settings: { ...layoutFixture.store.getState().settings, theme: 'light' } }); layoutFixture.store.getState().applyTheme()`); await sleep(400); await shot('light-cards');
    win.setContentSize(430, 932); await sleep(500); await shot('narrow-list');
    if (!baseline) await check(`!document.querySelector('[data-library-canvas]').offsetParent && !!document.querySelector('[data-artifact-row]')`, 'narrow-list-visible');
    report.reads = await run('({...layoutFixture.reads})');
    report.background = { visible: win.isVisible(), focusable: win.isFocusable() };
    if (report.background.visible || report.background.focusable || report.errors.length) throw Error('Unsafe window or renderer errors');
  } catch (error) { report.failure = String(error.stack || error); process.exitCode = 1; }
  finally { report.reads = await run('({...layoutFixture.reads})').catch(() => null); fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); win.destroy(); app.exit(process.exitCode || 0); }
});
