const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const dir = process.env.NEKKO_EVIDENCE_DIR, kind = process.env.NEKKO_EVIDENCE_KIND;
app.commandLine.appendSwitch('force-device-scale-factor', '1');
const profile = fs.mkdtempSync(path.join(dir, 'profile-'));
app.setPath('userData', profile);
app.setPath('sessionData', profile);
const report = { kind, captures: [], errors: [] };
// JSON.stringify leaves <, >, / and U+2028/2029 raw; escape them before splicing into evaluated code.
const js = (v) => JSON.stringify(v).replace(/[<>/\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// DOM clicks only, never OS input. Each returns whether it found its target.
const clickText = (selector, text) => `(() => { const b = [...document.querySelectorAll(${js(selector)})].find((x) => x.textContent.trim().startsWith(${js(text)})); if (!b) return false; b.click(); return true; })()`;
const EXPAND = (name) => `(() => { const b = [...document.querySelectorAll('button[aria-expanded]')].find((x) => x.textContent.includes(${js(name)})); if (!b) return false; b.click(); return true; })()`;
const LAYOUT = `(() => {
  const problems = [];
  for (const el of document.querySelectorAll('main *, [role=dialog] *')) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (r.right > innerWidth + 1) problems.push('past right edge: ' + el.tagName + ' ' + (el.textContent || '').trim().slice(0, 40));
  }
  return {
    galleryCards: document.querySelectorAll('[data-template]').length,
    setup: Boolean(document.querySelector('[data-template-setup]')),
    paused: Boolean(document.querySelector('[data-automations-paused]')),
    failure: Boolean(document.querySelector('[data-run-failure]')),
    result: Boolean(document.querySelector('[data-run-result]')),
    dialogs: document.querySelectorAll('[role=dialog]').length,
    problems: [...new Set(problems)].slice(0, 10),
  };
})()`;

// Each scene: the fixture's data set, then the DOM steps that lead to the shot.
const SCENES = [
  { name: 'empty', data: 'empty', steps: [] },
  { name: 'gallery', data: 'empty', steps: [clickText('main button', 'New workflow')] },
  { name: 'setup', data: 'empty', steps: [clickText('main button', 'New workflow'), `(() => { const b = document.querySelector('[role=dialog] [data-template="nightly-dependency-check"]'); if (!b) return false; b.click(); return true; })()`] },
  { name: 'run-failed', data: 'list', steps: [EXPAND('Review every PR I open')] },
  { name: 'run-result', data: 'list', steps: [EXPAND('Nightly dependency check')] },
  { name: 'paused', data: 'paused', steps: [] },
  { name: 'editor', data: 'list', steps: [`(() => { const row = [...document.querySelectorAll('main .card')].find((x) => x.textContent.includes('Nightly dependency check')); const b = row && [...row.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Edit'); if (!b) return false; b.click(); return true; })()`] },
  { name: 'setup-review', data: 'empty', steps: [clickText('main button', 'New workflow'), `(() => { const b = document.querySelector('[role=dialog] [data-template="review-my-prs"]'); if (!b) return false; b.click(); return true; })()`] },
  { name: 'editor-notools', data: 'list', steps: [`(() => { const row = [...document.querySelectorAll('main .card')].find((x) => x.textContent.includes('Nightly dependency check')); const b = row && [...row.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Edit'); if (!b) return false; b.click(); return true; })()`, `(() => { const t = [...document.querySelectorAll('[role=dialog] span')].find((x) => x.textContent.startsWith('No tools')); if (!t) return false; t.scrollIntoView({ block: 'center' }); return true; })()`] },
  { name: 'editor-review', data: 'list', steps: [`(() => { const row = [...document.querySelectorAll('main .card')].find((x) => x.textContent.includes('Review every PR I open')); const b = row && [...row.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Edit'); if (!b) return false; b.click(); return true; })()`, `(() => { const t = [...document.querySelectorAll('[role=dialog] span')].find((x) => x.textContent.trim() === 'Only by'); if (!t) return false; t.scrollIntoView({ block: 'center' }); return true; })()`] },
];

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((r, done) => done({ cancel: !/^(file:|data:|blob:)/.test(r.url) }));
  session.defaultSession.setPermissionRequestHandler((w, p, d) => d(false));
  const left = Math.min(...screen.getAllDisplays().map((d) => d.bounds.x));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: left - 5000, y: -3000, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.webContents.on('console-message', (e) => { if (e.level === 'error') report.errors.push(e.message); });
  const run = (s) => win.webContents.executeJavaScript(s, true);
  try {
    win.showInactive();
    for (const theme of ['dark', 'light']) {
      for (const [i, scene] of SCENES.entries()) {
        // A fresh page per scene: the query differs every time, so nothing carries over.
        await win.loadFile(path.join(dir, 'index.html'), { query: { data: scene.data, n: `${theme}-${i}` } });
        await run(`document.documentElement.dataset.theme=${js(theme)}`);
        await run('document.fonts.ready');
        await sleep(400);
        const clicked = [];
        for (const s of scene.steps) { clicked.push(await run(s)); await sleep(300); }
        await sleep(400);
        const img = await win.capturePage(undefined, { stayHidden: true, stayAwake: true });
        if (img.isEmpty()) throw Error('Empty screenshot');
        fs.writeFileSync(path.join(dir, `workflows-${kind}-${scene.name}-${theme}.png`), img.toPNG());
        report.captures.push({ name: `${scene.name}-${theme}`, clicked, layout: await run(LAYOUT) });
      }
    }
  } catch (e) {
    report.errors.push(String(e));
  } finally {
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ kind, captures: report.captures.map((c) => ({ name: c.name, clicked: c.clicked, layout: c.layout })), errors: report.errors }));
    win.destroy();
    app.exit(report.errors.length ? 1 : 0);
  }
});
