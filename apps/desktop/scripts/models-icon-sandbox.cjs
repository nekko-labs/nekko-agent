// Real App, stub bridge, disposable profile, no network or visible windows.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Use layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
app.setPath('sessionData', path.join(out, 'profile'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ title: 'Library and Models icons isolated evidence', width: 1440, height: 900, useContentSize: true, show: false, focusable: false, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const report = { checks: [], errors: [], captures: [], layouts: [] };
  win.on('show', () => report.errors.push('Window shown'));
  win.on('focus', () => report.errors.push('Window focused'));
  const run = code => win.webContents.executeJavaScript(code, true);
  const check = async (code, label) => { if (!await run(code)) throw Error(label); report.checks.push(label); };
  const capture = async name => {
    const file = path.join(out, name + '.png');
    fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG());
    report.captures.push(file);
  };
  try {
    await win.loadFile(path.join(out, 'index.html')); await sleep(2000);
    await run(`(async () => { const f = window.layoutFixture; const settings = await f.bridge.updateSettings({showTips:false, firstPromptIntroSeen:true}); f.store.setState({settings}); localStorage.setItem('nekko.libraryIntroSeen', '1'); })()`);
    await sleep(400);
    await run('document.querySelector(\'.zones-intro button[aria-label="Close"]\')?.click()');
    const cdp = win.webContents.debugger; cdp.attach('1.3');
    await cdp.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await cdp.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    for (const width of [1440, 900, 390]) {
      win.setContentSize(width, 900); await sleep(400);
      await run(`window.layoutFixture.store.getState().setView('command'); document.activeElement?.blur(); document.querySelector('.rail')?.removeAttribute('data-open')`);
      win.webContents.sendInputEvent({ type: 'mouseMove', x: width - 5, y: 5 });
      await sleep(400);
      await capture(`${width}-rest`);
      if (width < 768) {
        await check(`document.querySelectorAll('.phone-tab').length >= 2 && !document.querySelector('.phone-tab[aria-label="Library"], .phone-tab[aria-label="Models"]')`, '390: default phone tabs unchanged');
        continue;
      }
      for (const [label, view, glyph] of [['Library', 'artifacts', 'grid'], ['Models', 'models', 'brain-circuit']]) {
        const selector = `.nav-item[aria-label="${label}"]`;
        await check(`(() => { const s = document.querySelector('${selector} svg'); const r = s.getBoundingClientRect(); return r.width === 22 && r.height === 22; })()`, `${width}: ${label} remains 22px`);
        if (!process.env.NEKKO_BEFORE) {
          await check(`document.querySelector('${selector} svg').dataset.gentlefaceIcon === '${glyph}'`, `${width}: ${label} uses Gentleface ${glyph}`);
        }
        // Windows hidden windows do not reliably synthesize CSS :hover (also on the unchanged baseline).
        // Use the rail's existing pinned-open state for matched expanded captures.
        await run(`document.querySelector('.rail').setAttribute('data-open', '')`); await sleep(500);
        await check(`document.querySelector('.rail').getBoundingClientRect().width > 190`, `${width}: expanded rail for ${label}`);
        await capture(`${width}-${view}-expanded`);
        await run(`document.querySelector('${selector}').focus()`);
        await check(`document.activeElement?.getAttribute('aria-label') === '${label}'`, `${width}: ${label} keyboard focus retained`);
        await run(`document.querySelector('${selector}').click()`); await sleep(600);
        await check(`window.layoutFixture.store.getState().view === '${view}' && document.querySelector('${selector}').classList.contains('active')`, `${width}: ${label} navigation and active state retained`);
        await capture(`${width}-${view}-active`);
      }
    }
    cdp.detach(); report.background = { visible: win.isVisible(), focused: win.isFocused(), bounds: win.getBounds() };
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  win.destroy(); app.exit(report.errors.length ? 1 : 0);
});
