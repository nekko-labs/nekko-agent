// Matched new/active composer evidence with synthetic folders and no host access.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Use layout-evidence-integration.cjs');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.setPath('userData', path.join(out, 'profile'));
const baseline = process.env.NEKKO_FOLDERS_BASELINE === '1';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { assertions: [], captures: [], errors: [] };
const js = value => JSON.stringify(value).replaceAll('<', '\\u003c');
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1000, height: 800, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -10000, y: -10000, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const check = (name, pass) => { report.assertions.push({ name, pass }); if (!baseline && !pass) throw Error(name); };
  const shot = async name => { const f = path.join(out, name + '.png'); fs.writeFileSync(f, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(f); };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 60 && !await run('!!window.layoutFixture'); i++) await sleep(100);
    for (const width of [1000, 390]) for (const expert of [true, false]) for (const clean of [true, false]) {
      win.setContentSize(width, 800);
      await run(`layoutFixture.showFolderComposer(${clean}, ${expert})`);
      await sleep(600);
      const label = `${clean ? 'new' : 'active'}-${expert ? 'detailed' : 'simple'}-${width}`;
      const metrics = await run(`(() => {
        const bar = document.querySelector('.composer-bar');
        const folder = bar.querySelector('.composer-folders');
        const plus = bar.querySelector('[aria-label="Add a photo, video, file, folder, or skill"]');
        const suggest = document.querySelector('[data-prompt-suggestions]');
        const rect = e => e?.getBoundingClientRect();
        const modeRow = document.querySelector('[data-composer-mode-row]');
        const mode = modeRow?.querySelector('button');
        return { first: !!plus && bar.firstElementChild.contains(plus), count: document.querySelectorAll('[aria-label^="Selected folders:"]').length,
          next: !!folder && folder.previousElementSibling?.contains(plus),
          aligned: !!suggest && !!mode && modeRow.contains(suggest) && Math.abs((rect(suggest).top + rect(suggest).bottom) / 2 - (rect(mode).top + rect(mode).bottom) / 2) < 2 && Math.abs(rect(suggest).right - (rect(modeRow).right - 8)) < 2,
          overflow: document.documentElement.scrollWidth > innerWidth,
          fits: !!folder && rect(folder).width >= 28 && rect(folder).right <= innerWidth };
      })()`);
      check(label + ': one folders control immediately after plus', metrics.first && metrics.count === 1 && metrics.fits && metrics.next);
      check(label + ': no page overflow', !metrics.overflow);
      check(label + ': suggestions at far right of Mode only in Detailed', expert ? metrics.aligned : !await run('!!document.querySelector("[data-composer-suggestions]")'));
      await shot(label);
      if (expert) {
        const mode = await run(`(() => { const b = document.querySelector('[data-composer-mode-row] button'); if (!b) return false; b.click(); return true; })()`);
        if (mode) {
          await sleep(200);
          check(label + ': no Folders section in Mode', !await run(`!!document.querySelector('.mode-folders')`));
          if (width === 1000 && !clean) await shot('mode-detailed-1000');
          await run(`document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`);
        }
      }
      if (!baseline) {
        if (expert) {
          await run(`document.querySelector('[data-prompt-suggestions]').click()`); await sleep(150);
          check(label + ': suggestions dialog opens within viewport', await run(`(() => { const r = document.querySelector('[role="dialog"][aria-label="Prompt suggestions"]')?.getBoundingClientRect(); return !!r && r.left >= 0 && r.right <= innerWidth && r.top >= 0; })()`));
          await run(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`); await sleep(100);
          check(label + ': suggestions Escape restores focus', await run(`!document.querySelector('[aria-label="Prompt suggestions"]') && document.activeElement === document.querySelector('[data-prompt-suggestions]')`));
        }
        await run(`document.querySelector('.composer-folders button').click()`); await sleep(200);
        check(label + ': folder menu opens', await run(`!!document.querySelector('[role="menu"][aria-label="Primary folder"]')`));
        if (expert && !clean) await shot('folders-menu-' + width);
        await run(`Array.from(document.querySelectorAll('[role="menuitemradio"]')).find(e => e.textContent.includes('docs')).click()`); await sleep(200);
        check(label + ': picking retains original as supporting', await run(`layoutFixture.records[0].workspaceId === 'docs' && layoutFixture.records[0].supportingWorkspaceIds.includes('code')`));
        await run(`document.querySelector('.composer-folders button').click()`); await sleep(100);
        await run(`document.querySelector('[aria-label="Remove code from this chat"]').click()`); await sleep(150);
        check(label + ': remove is per-chat, not saved-access revocation', await run(`layoutFixture.records[0].workspaceId === 'docs' && !layoutFixture.records[0].supportingWorkspaceIds.includes('code') && layoutFixture.settings.workspaces.length === 2`));
        await run(`document.querySelector('.composer-folders button').click()`); await sleep(100);
        await run(`document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`); await sleep(100);
        check(label + ': Escape closes and restores focus', await run(`!document.querySelector('[role="menu"][aria-label="Primary folder"]') && document.activeElement === document.querySelector('.composer-folders button')`));
      }
    }
    for (const width of [1000, 390]) for (const surface of ['full', 'composer']) {
      win.setContentSize(width, 800);
      await run(`layoutFixture.showFolderComposer(false, true, ${js(surface)})`); await sleep(350);
      check(surface + ': folders after plus', await run(`document.querySelector('.composer-bar').children[1].classList.contains('composer-folders')`));
      check(surface + ': suggestions share Mode row', await run(`!!document.querySelector('[data-composer-mode-row] [data-composer-suggestions]')`));
      await shot(surface + '-detailed-' + width);
    }
    if (!baseline) {
      win.setContentSize(1000, 800);
      await run(`layoutFixture.showFolderComposer(true, true, 'window', '')`); await sleep(350);
      check('empty draft has no blank suggestions row', await run(`getComputedStyle(document.querySelector('[data-composer-suggestions]')).display === 'none'`));
      await shot('empty-detailed-1000');
    }
    report.background = { visible: win.isVisible(), focusable: win.isFocusable(), bounds: win.getBounds() };
  } catch (e) { report.failure = String(e.stack || e); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  win.destroy();
  app.exit(report.failure ? 1 : 0);
});
