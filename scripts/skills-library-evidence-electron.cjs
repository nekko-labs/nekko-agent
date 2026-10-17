const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const dir = process.env.NEKKO_EVIDENCE_DIR, kind = process.env.NEKKO_EVIDENCE_KIND;
app.commandLine.appendSwitch('force-device-scale-factor', '1');
const profile = fs.mkdtempSync(path.join(dir, 'profile-'));
app.setPath('userData', profile);
app.setPath('sessionData', profile);
const report = { kind, captures: [], errors: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Click the first button whose text starts with "/goal" (a list row before, a card after).
const OPEN_GOAL = `(() => { const b = [...document.querySelectorAll('main button')].find((x) => x.textContent.trim().startsWith('/goal')); if (!b) return false; b.click(); return true; })()`;
// What a reader of the PNG would check: grid columns, card count, drawer, and anything overflowing the window.
const LAYOUT = `(() => {
  const grid = document.querySelector('[data-skill-grid]');
  const problems = [];
  for (const el of document.querySelectorAll('main *')) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (r.right > innerWidth + 1) problems.push('past right edge: ' + el.tagName + ' ' + (el.textContent || '').trim().slice(0, 40));
  }
  return {
    gridColumns: grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : null,
    cards: document.querySelectorAll('[data-skill-card]').length,
    drawer: Boolean(document.querySelector('[data-skill-drawer]')),
    problems: [...new Set(problems)].slice(0, 10),
  };
})()`;
const SIZES = [{ name: 'desktop', w: 1440, h: 900 }, { name: 'narrow', w: 960, h: 800 }];
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((r, done) => done({ cancel: !/^(file:|data:|blob:)/.test(r.url) }));
  session.defaultSession.setPermissionRequestHandler((w, p, d) => d(false));
  const left = Math.min(...screen.getAllDisplays().map((d) => d.bounds.x));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: left - 5000, y: -3000, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.webContents.on('console-message', (e) => { if (e.level === 'error') report.errors.push(e.message); });
  const run = (s) => win.webContents.executeJavaScript(s, true);
  const shot = async (name, extra) => {
    await sleep(500);
    const img = await win.capturePage(undefined, { stayHidden: true, stayAwake: true });
    if (img.isEmpty()) throw Error('Empty screenshot');
    fs.writeFileSync(path.join(dir, `skills-${kind}-${name}.png`), img.toPNG());
    report.captures.push({ name, size: img.getSize(), layout: await run(LAYOUT), ...extra });
  };
  try {
    win.showInactive();
    for (const size of SIZES) {
      for (const theme of ['dark', 'light']) {
        if (size.name === 'narrow' && theme === 'light') continue;
        win.setContentSize(size.w, size.h);
        await win.loadFile(path.join(dir, 'index.html'));
        await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
        await run('document.fonts.ready');
        await sleep(400);
        await shot(`${size.name}-${theme}`);
        const clicked = await run(OPEN_GOAL);
        await shot(`${size.name}-${theme}-goal`, { clicked });
        // Esc closes the drawer (sent as a DOM event, never OS input).
        report.captures.at(-1).escCloses = await run(`(() => { if (!document.querySelector('[data-skill-drawer]')) return null; dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return new Promise((r) => requestAnimationFrame(() => r(!document.querySelector('[data-skill-drawer]')))); })()`);
      }
    }
  } catch (e) {
    report.errors.push(String(e));
  } finally {
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ kind, captures: report.captures.map((c) => ({ name: c.name, size: c.size, layout: c.layout, clicked: c.clicked, escCloses: c.escCloses })), errors: report.errors }));
    win.destroy();
    app.exit(report.errors.length ? 1 : 0);
  }
});
