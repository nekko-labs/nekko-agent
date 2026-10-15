// Electron side of panel-grips-integration.cjs. Hidden, unfocusable windows on a
// throwaway profile with every network request cancelled. Measures each
// vertical resize grip on the wall and how close the windows come to it, and
// captures the grips and the tray companion (first-close guidance).
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through panel-grips-integration.cjs');
const runDir = path.join(out, new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(runDir, { recursive: true });
app.setPath('userData', path.join(runDir, 'profile'));
app.setPath('sessionData', path.join(runDir, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { facts: {}, captures: [], errors: [] };
const far = () => { const b = screen.getAllDisplays().map(d => d.bounds); return { x: Math.min(...b.map(v => v.x)) - 1700, y: Math.min(...b.map(v => v.y)) - 1100 }; };
const hidden = { show: false, focusable: false, skipTaskbar: true, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } };

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_wc, _p, done) => done(false));
  const capture = async (win, name, rect) => { const file = path.join(runDir, name + '.png'); fs.writeFileSync(file, (await win.capturePage(rect, { stayHidden: true, stayAwake: false })).toPNG()); report.captures.push(file); };
  try {
    // 1. The wall: agent list on the left, Panels dock on the right.
    const win = new BrowserWindow({ ...hidden, ...far(), width: 1400, height: 820, useContentSize: true, title: 'Synthetic panel grip verification' });
    win.on('focus', () => { report.errors.push('Verification window took OS focus'); process.exitCode = 1; });
    win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
    const run = s => win.webContents.executeJavaScript(s, true);
    await win.loadFile(path.join(out, 'index.html'), { search: 'quota' });
    win.showInactive();
    await sleep(1600);
    const facts = async (hover) => run(`(async () => {
      const r = el => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: +b.x.toFixed(1), w: +b.width.toFixed(1), y: Math.round(b.y), h: Math.round(b.height) }; };
      const grips = [...document.querySelectorAll('[role=separator][aria-orientation=vertical]')].filter(el => el.getClientRects().length && !el.closest('.command-wall-divider-box') && !el.classList.contains('wall-composer-side'));
      const windows = [...document.querySelectorAll('[data-wall-pane]')].map(el => el.getBoundingClientRect());
      const left = Math.min(...windows.map(b => b.left)), right = Math.max(...windows.map(b => b.right));
      return grips.map(el => {
        const box = el.getBoundingClientRect(); const mark = [...el.querySelectorAll('*')].map(c => ({ c, b: c.getBoundingClientRect(), s: getComputedStyle(c) })).find(m => m.b.width > 0 && m.b.width <= 4) || null;
        const after = getComputedStyle(el, '::after');
        return { label: el.getAttribute('aria-label'), className: el.className, hit: r(el), mark: mark && { x: +mark.b.x.toFixed(1), w: +mark.b.width.toFixed(1), h: Math.round(mark.b.height), opacity: mark.s.opacity, bg: mark.s.backgroundColor }, after: after.content !== 'none' ? { w: after.width, h: after.height, bg: after.backgroundColor } : null, bg: getComputedStyle(el).backgroundColor,
          windowGapLeft: +(left - box.right).toFixed(1), windowGapRight: +(box.left - right).toFixed(1) };
      });
    })()`);
    report.facts.rest = await facts();
    const shot = async (name) => {
      const g = await run(`[...document.querySelectorAll('[role=separator][aria-orientation=vertical]')].filter(el => el.getClientRects().length && !el.closest('.command-wall-divider-box') && !el.classList.contains('wall-composer-side')).map(el => { const b = el.getBoundingClientRect(); return { x: Math.round(b.x), label: el.getAttribute('aria-label') }; })`);
      for (const { x, label } of g) await capture(win, `${name}-${/agent list/.test(label) ? 'left' : 'right'}`, { x: Math.max(0, x - 70), y: 40, width: 140, height: 520 });
      await capture(win, `${name}-wall`);
    };
    await shot('grips-rest');
    // Hover each grip the way a pointer does (CDP, no OS input).
    win.webContents.debugger.attach('1.3');
    const grips = await run(`[...document.querySelectorAll('[role=separator][aria-orientation=vertical]')].filter(el => el.getClientRects().length && !el.closest('.command-wall-divider-box') && !el.classList.contains('wall-composer-side')).map(el => { const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, label: el.getAttribute('aria-label') }; })`);
    for (const g of grips) {
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(g.x), y: Math.round(g.y) });
      await sleep(300);
      const side = /agent list/.test(g.label) ? 'left' : 'right';
      report.facts['hover-' + side] = (await facts()).find(f => f.label === g.label);
      await capture(win, `grips-hover-${side}`, { x: Math.max(0, Math.round(g.x) - 70), y: 40, width: 140, height: 520 });
    }
    win.webContents.debugger.detach();
    win.destroy();

    // 2. The tray companion's first-close guidance, at the size the app opens it.
    const { companionHtml } = require(path.join(out, 'companion.cjs'));
    const tipSession = session.fromPartition('tray-companion');
    tipSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:)/.test(d.url) }));
    const tip = new BrowserWindow({ ...hidden, ...far(), width: 340, height: 180, useContentSize: true, frame: false, backgroundColor: '#101714', title: 'Synthetic tray companion verification', webPreferences: { ...hidden.webPreferences, session: tipSession } });
    tip.webContents.on('did-fail-load', (_e, code, desc, url) => report.errors.push(`companion load ${code} ${desc} ${url.slice(0, 80)}`));
    // Loaded from a file: a data: URL with a '#' colour in it is cut at the
    // '#' by the page loader here, while the app encodes the whole page.
    fs.writeFileSync(path.join(runDir, 'companion.html'), companionHtml(true, true, true));
    await tip.loadFile(path.join(runDir, 'companion.html'));
    tip.showInactive();
    await sleep(500);
    report.facts.tip = await tip.webContents.executeJavaScript(`({ scrollH: document.documentElement.scrollHeight, clientH: document.documentElement.clientHeight, overflows: document.documentElement.scrollHeight > document.documentElement.clientHeight, links: [...document.querySelectorAll('a')].map(a => ({ text: a.textContent, h: Math.round(a.getBoundingClientRect().height) })), close: !!document.querySelector('[aria-label="Dismiss"]') })`, true);
    await capture(tip, 'tray-companion');
    tip.destroy();
  } catch (e) {
    report.errors.push(String(e && e.stack || e));
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(report, null, 1));
    console.log(JSON.stringify({ runDir, errors: report.errors, facts: report.facts }, null, 1));
    app.quit();
  }
});
