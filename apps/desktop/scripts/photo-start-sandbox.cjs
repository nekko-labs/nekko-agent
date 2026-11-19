// Captures a new Photo chat (photo-start-fixture.tsx) hidden, off-screen and
// non-focusable: with picture models, with none, and mid-download, at a wide
// and a narrow window, plus each of its menus when the build has them.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], checks: {}, errors: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const minX = Math.min(...screen.getAllDisplays().map(d => d.bounds.x)), minY = Math.min(...screen.getAllDisplays().map(d => d.bounds.y));
  const win = new BrowserWindow({ width: 1100, height: 820, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: minX - 2000, y: minY - 1200, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const freeze = () => run("document.getAnimations().forEach(a => { if (a.effect?.getTiming().iterations === Infinity) { a.pause(); a.currentTime = 12000; } else { try { a.finish(); } catch {} } })");
  const shot = async name => { await sleep(500); await freeze(); await win.capturePage(undefined, { stayHidden: true }); await sleep(200); const f = path.join(out, name + '.png'); fs.writeFileSync(f, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(name); };
  const settle = async probe => { for (let i = 0; i < 60 && !(await run(probe)); i++) await sleep(150); };
  const click = sel => run(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return false; b.click(); return true; })()`);
  try {
    for (const mode of ['ready', 'none', 'downloading']) {
      for (const width of [1100, 520]) {
        win.setContentSize(width, 820);
        await win.loadFile(path.join(out, 'index.html'));
        await run(`localStorage.setItem('fixture.photo', '${mode}')`);
        await win.reload();
        await settle('!!window.photoStart');
        await sleep(1200);
        await shot(`${mode}-${width}`);
        report.checks[`${mode}-${width}`] = await run("({ cleanStart: !!document.querySelector('[data-clean-start]'), setup: document.querySelector('[data-photo-setup]')?.dataset.photoSetup ?? null, editor: !!document.querySelector('.composer [contenteditable]')?.offsetParent, open: !!document.querySelector('[data-photo-setup-open]'), setupOpacity: (() => { const e = document.querySelector('.photo-setup'); return e ? getComputedStyle(e).opacity + ' ' + e.getBoundingClientRect().height + ' ' + getComputedStyle(e).color : null; })() })");
        if (mode !== 'ready') continue;
        for (const [name, sel] of [['shape', '[data-photo-shape-trigger]'], ['model', '[data-photo-model-trigger]'], ['advanced', '[data-photo-advanced-trigger]']]) {
          if (!(await click(sel))) continue;
          await shot(`${mode}-${width}-${name}`);
          report.checks[`${mode}-${width}-${name}`] = await run("(() => { const m = document.querySelector('.photo-menu'); if (!m) return null; const c = getComputedStyle(m); return { opacity: c.opacity, bg: c.backgroundColor, anims: m.getAnimations().map(a => a.playState + ' ' + a.currentTime), rows: m.querySelectorAll('[role=option]').length }; })()");
          await run("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
          await sleep(250);
        }
      }
    }
    for (const mode of ['ready', 'none']) {
      win.setContentSize(1100, 820);
      await win.loadFile(path.join(out, 'index.html'));
      await run(`localStorage.setItem('fixture.photo', '${mode}'); localStorage.setItem('fixture.plain', '1')`);
      await win.reload();
      await settle('!!window.photoStart');
      await sleep(1200);
      await shot(`plain-${mode}-1100`);
      await run("localStorage.removeItem('fixture.plain')");
    }
  } catch (e) { report.errors.push(String(e)); process.exitCode = 1; }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 1));
  win.destroy(); app.exit(process.exitCode || 0);
});
