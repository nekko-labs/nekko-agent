// The Budget monitor's "where tokens went" rows (#2494): real MonitorsDock,
// synthetic usage, hidden isolated Electron window that never takes focus or
// reaches the network.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Run through layout-evidence-integration.cjs');
const before = process.env.NEKKO_TEST_LABEL === 'attribution-before';
const profile = path.join(out, 'profile');
app.setPath('userData', profile);
app.setPath('sessionData', profile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((r, done) => done({ cancel: !/^(file:|data:|blob:)/.test(r.url) }));
  session.defaultSession.setPermissionRequestHandler((_c, _p, done) => done(false));
  const win = new BrowserWindow({ width: 420, height: 1100, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -12000, y: -12000, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  const report = { checks: [], errors: [] };
  win.on('focus', () => report.errors.push('Unexpected window focus'));
  win.webContents.on('console-message', (e) => { if (e.level === 'error') report.errors.push(e.message); });
  const run = (code) => win.webContents.executeJavaScript(code, true);
  const check = (name, passed) => { report.checks.push({ name, passed: !!passed }); if (!passed) throw Error(name); };
  try {
    await win.loadFile(path.join(out, 'index.html'), before ? { search: 'before' } : undefined);
    await sleep(1500);
    win.webContents.invalidate();
    await sleep(1500);
    check('budget monitor shown', await run('!!document.querySelector(".monitors-dock__budget")'));
    check('no horizontal overflow', await run('document.documentElement.scrollWidth <= innerWidth'));
    if (!before) {
      const rows = await run('[...document.querySelectorAll("[data-usage-attribution] [data-row]")].map((r) => r.dataset.row).join(",")');
      check('all six rows', rows === 'user,background,parent,subagent,cache-read,new-input');
      check('shares are percentages', await run('[...document.querySelectorAll("[data-usage-attribution] dd")].every((d) => /^\\d+%/.test(d.textContent))'));
    } else {
      check('no attribution without attributed days', await run('!document.querySelector("[data-usage-attribution]")'));
    }
    // Scroll the monitor's own scroller (not the page) to the breakdown rows.
    await run(`(() => {
      const el = document.querySelector(".monitors-dock__budget dl");
      let p = el.parentElement;
      while (p && !(p.scrollHeight > p.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(p).overflowY))) p = p.parentElement;
      if (p) p.scrollTop += el.getBoundingClientRect().top - p.getBoundingClientRect().top - 8;
    })()`);
    await sleep(300);
    const rect = await run('JSON.stringify(document.querySelector("[data-shot=budget]").getBoundingClientRect())');
    const r = JSON.parse(rect);
    win.webContents.invalidate();
    await sleep(200);
    const img = await win.capturePage({ x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.min(1080, Math.ceil(r.height)) }, { stayHidden: true });
    fs.writeFileSync(path.join(out, 'budget.png'), img.toPNG());
    {
      await run(`(() => {
        // Capture aid only: unclip the monitor tile so every row is in one frame.
        for (let p = document.querySelector(".monitors-dock__budget dl"); p && !p.matches("[data-shot]"); p = p.parentElement) {
          Object.assign(p.style, { maxHeight: "none", height: "auto", overflow: "visible" });
        }
      })()`);
      await sleep(300);
      win.webContents.invalidate();
      await sleep(200);
      const more = await win.capturePage({ x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.min(1080, Math.ceil(r.height)) }, { stayHidden: true });
      fs.writeFileSync(path.join(out, 'budget-cache.png'), more.toPNG());
    }
  } catch (e) {
    report.errors.push(String((e && e.stack) || e));
  } finally {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    win.destroy();
    app.exit(report.errors.length ? 1 : 0);
  }
});
