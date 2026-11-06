// Page zoom at each text size, through the real webFrame call: every coordinate
// space must agree, anything placed from a measured position must land on it,
// and a viewport-sized box must fit the window. Captures the main screens.
// Launch: NEKKO_LAYOUT_SANDBOX=text-size-popover-sandbox.cjs node layout-evidence-integration.cjs
// Stub bridge only. Hidden, non-focusable window; clicks are DOM events, no OS input.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
app.setPath('sessionData', path.join(out, 'profile'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const js = (v) => JSON.stringify(v).replace(/[<>/  ]/g, (c) => '\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((r, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(r.url) }));
  session.defaultSession.setPermissionRequestHandler((_c, _p, done) => done(false));
  const left = Math.min(...screen.getAllDisplays().map((d) => d.bounds.x));
  const report = { checks: [], errors: [], measures: {} };
  const check = (name, ok) => report.checks.push({ name, passed: !!ok });
  const win = new BrowserWindow({
    width: 1280, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: left - 3000, y: -2000,
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false, ...(process.env.NEKKO_CSS_ZOOM ? {} : { preload: path.join(__dirname, 'text-size-preload.cjs') }) },
  });
  win.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 3) report.errors.push('console: ' + String(e.message).slice(0, 220)); });
  win.on('focus', () => report.errors.push('Fixture took focus'));
  const run = (source) => win.webContents.executeJavaScript(source, true);
  const capture = async (name) => {
    await sleep(500);
    fs.writeFileSync(path.join(out, name + '.png'), (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG());
  };
  const setScale = async (scale) => {
    await run(`window.nekko.updateSettings({ textScale: ${scale} }).then((s) => { layoutFixture.store.setState({ settings: { ...s } }); layoutFixture.store.getState().applyTheme(); })`);
    await sleep(600);
  };
  // A box placed where a measured element is, the way every menu does it, and a viewport-sized box.
  const primitives = () => run(`(() => {
    const anchor = document.querySelector('button').getBoundingClientRect();
    const box = (css) => { const n = document.createElement('div'); n.style.cssText = css; document.body.append(n); const r = n.getBoundingClientRect(); n.remove(); return r; };
    const placed = box('position:fixed;width:50px;height:50px;left:' + anchor.left + 'px;top:' + anchor.bottom + 'px');
    const screenBox = box('position:fixed;left:0;top:0;width:100vw;height:100vh');
    const hit = document.elementFromPoint(anchor.left + anchor.width / 2, anchor.top + anchor.height / 2);
    return { innerWidth, innerHeight, cssZoom: document.documentElement.style.zoom, placedOffX: placed.left - anchor.left, placedOffY: placed.top - anchor.bottom, vhFits: Math.abs(screenBox.height - innerHeight) < 1 && Math.abs(screenBox.width - innerWidth) < 1, hitIsButton: !!hit?.closest('button') };
  })()`);
  // A real popover placed from a rect: the search box must open where its button is.
  const searchBox = () => run(`(async () => {
    const b = document.querySelector('.settings-search-btn');
    if (!b) return null;
    b.scrollIntoView({ block: 'center' });
    await new Promise((r) => setTimeout(r, 150));
    const a = b.getBoundingClientRect();
    b.click();
    await new Promise((r) => setTimeout(r, 300));
    const p = document.querySelector('.settings-search-pop');
    if (!p) return null;
    const r = p.getBoundingClientRect();
    const result = { offRight: Math.round(r.right - a.right), offTop: Math.round(r.top - a.top), offscreen: r.right > innerWidth + 1 || r.left < -1 || r.bottom > innerHeight + 1 };
    p.querySelector('input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    return result;
  })()`);
  try {
    await win.loadFile(path.join(out, 'index.html'));
    await sleep(1500);
    for (const scale of [80, 100, 125, 150]) {
      await setScale(scale);
      await run(`layoutFixture.store.getState().setView('settings')`);
      await sleep(900);
      const p = await primitives();
      const search = await searchBox();
      p.search = search;
      report.measures[scale] = { ...p, factor: win.webContents.getZoomFactor() };
      check(`${scale}% page zoom is set and CSS zoom is not`, Math.abs(win.webContents.getZoomFactor() - scale / 100) < 0.01 && p.cssZoom === '');
      check(`${scale}% window size scales with it`, Math.abs(p.innerWidth - 1280 / (scale / 100)) < 3);
      check(`${scale}% a box placed from a rect lands on it`, Math.abs(p.placedOffX) < 1 && Math.abs(p.placedOffY) < 1);
      check(`${scale}% 100vh fits the window`, p.vhFits);
      check(`${scale}% Settings search opens on its button`, search && Math.abs(search.offRight) < 2 && Math.abs(search.offTop) <= 4 && !search.offscreen);
      check(`${scale}% a measured point hits what was measured`, p.hitIsButton);
      for (const view of ['command', 'models', 'settings']) {
        await run(`layoutFixture.store.getState().setView(${js(view)})`);
        await sleep(900);
        // The first-run tip covers the Agents board.
        await run(`[...document.querySelectorAll('[role="dialog"] button, .fixed button')].find((b) => /close|dismiss/i.test(b.getAttribute('aria-label') || ''))?.click()`);
        await sleep(300);
        const overflow = await run(`document.documentElement.scrollWidth - innerWidth`);
        if (view === 'command') report.measures[scale].composerBottom = await run(`(() => { const e = [...document.querySelectorAll('textarea, input, [data-placeholder], [aria-placeholder], [placeholder], [contenteditable]')].find((n) => n.getClientRects().length && /Message Nekko/.test(n.getAttribute('placeholder') || n.getAttribute('aria-placeholder') || n.getAttribute('data-placeholder') || n.textContent || '')) ?? [...document.querySelectorAll('div, p, span')].filter((n) => /^Message Nekko/.test(n.textContent.trim()) && n.getClientRects().length).at(-1); if (!e) return null; let box = e; while (box.parentElement && box.getBoundingClientRect().height < 90) box = box.parentElement; const r = box.getBoundingClientRect(); return { tag: e.tagName, cls: String(box.className).slice(0, 40), top: Math.round(r.top), bottom: Math.round(r.bottom), innerHeight, pastWindow: Math.round(r.bottom - innerHeight) }; })()`);
        if (view === 'command' && (scale === 100 || scale === 125)) await capture(`command-${scale}`);
        report.measures[scale][view + 'Overflow'] = overflow;
        check(`${scale}% ${view} has no sideways overflow`, overflow <= 1);
        if (scale === 150) await capture(`${view}-150`);
      }
    }
    await run(`document.getElementById('settings-accessibility')?.scrollIntoView({ block: 'start' })`);
    await capture('accessibility-150-page-zoom');
  } catch (e) {
    report.errors.push(String(e && e.stack || e));
  }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ total: report.checks.length, failed: report.checks.filter((c) => !c.passed).map((c) => c.name), errors: report.errors }, null, 1));
  app.exit(0);
});
