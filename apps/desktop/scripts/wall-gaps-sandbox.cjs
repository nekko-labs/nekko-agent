// Wall spacing evidence: two chats on the wall with the composer below, the
// agent panel and the Monitors dock, at several widths in Dynamic and Focused,
// with Windows chrome. Records each panel's box and the gaps between them.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
// JSON.stringify plus escapes for <, >, / and line separators, so values stay inert inside the injected script.
const js = v => JSON.stringify(v).replace(/[<>/\u2028\u2029]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], metrics: {}, errors: [] };
const SIZES = [[1280, 800], [1600, 900], [2000, 1100]];
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const minX = Math.min(...screen.getAllDisplays().map(d => d.bounds.x)), minY = Math.min(...screen.getAllDisplays().map(d => d.bounds.y));
  const win = new BrowserWindow({ width: 1600, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: minX - 2400, y: minY - 1400, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => { report.errors.push('took focus'); });
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const ready = async () => { for (let i = 0; i < 50 && !(await run("!!document.querySelector('[data-command-wall]')")); i++) await sleep(200); await sleep(900); };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    await run("localStorage.setItem('fixture.platform', 'win32')");
    await win.loadFile(path.join(out, 'index.html'));
    await ready();
    // Two chats on the wall, from the agent panel's cards.
    for (const title of ['Persist quota history', 'Diagnose failed build']) {
      await run(`(() => { const el = [...document.querySelectorAll('[data-agent-panel] *')].find(e => e.textContent.trim() === ${js(title)}); el && el.click(); })()`);
      await sleep(600);
    }
    // Close the one-time zones intro.
    await run("(() => { const b = [...document.querySelectorAll('[role=dialog] button')].find(e => /close/i.test(e.getAttribute('aria-label') || '')); b && b.click(); })()"); await sleep(500);
    for (const mode of ['Dynamic', 'Focused']) {
      await run(`(() => { const b = [...document.querySelectorAll('button')].find(e => e.textContent.trim() === ${js(mode)}); b && b.click(); })()`);
      await sleep(700);
      for (const [w, h] of SIZES) {
        win.setContentSize(w, h); await sleep(1800);
        const name = `${mode.toLowerCase()}-${w}x${h}`;
        fs.writeFileSync(path.join(out, name + '.png'), (await win.capturePage(undefined, { stayHidden: true })).toPNG());
        report.captures.push(name);
        report.metrics[name] = JSON.parse(await run(`JSON.stringify((() => {
          const r = e => { if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom) }; };
          const q = s => r(document.querySelector(s));
          const wins = [...document.querySelectorAll('.command-wall-window:not([data-wall-parked])')].map(e => ({ outer: r(e), panel: r(e.querySelector('.panel')), footer: r([...e.querySelectorAll('*')].filter(c => /Tools/.test(c.textContent) && c.children.length < 3).pop()) }));
          return { titlebar: q('.titlebar'), sidebar: q('[data-agent-panel]'), windows: wins, layout: q('.command-wall-layout'), scroll: (e => e && [e.scrollHeight, e.clientHeight, e.offsetWidth - e.clientWidth, getComputedStyle(e).scrollbarGutter])(document.querySelector('.command-wall-layout')), composer: q('.wall-composer'), dock: q('.monitors-dock') };
        })())`));
      }
    }
  } catch (e) { report.errors.push(String(e && e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  app.exit(report.captures.length ? 0 : 1);
});
