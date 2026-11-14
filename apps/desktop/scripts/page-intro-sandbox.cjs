// Full-App first-visit guides on Skills, Design, Connectors and Memory (#1273-#1276):
// synthetic bridge, isolated profile, hidden window, no network or OS input.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
// Baseline: capture the pages as they are, for the before shots.
const baseline = process.env.NEKKO_PAGE_INTRO_BASELINE === '1';
// Escape characters JSON.stringify leaves raw before splicing into evaluated code.
const js = (v) => JSON.stringify(v).replace(/[<>/\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { checks: {}, errors: [], captures: [] };
const PAGES = [['skills', 'Skills', 'Explore Skills'], ['design', 'Design', 'Start designing'], ['connectors', 'Connectors', 'Explore Connectors'], ['memory', 'Memory', 'Explore Memory']];
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  win.on('focus', () => report.errors.push('Window took focus'));
  const run = source => win.webContents.executeJavaScript(source);
  const check = async (source, label) => { const ok = await run(source); report.checks[label] = ok; if (!ok) throw Error(label); };
  const shot = async name => { const file = path.join(out, `${name}.png`); fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(file); };
  const click = text => run(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${js(text)}); if (!b) throw Error('Missing control ' + ${js(text)}); b.click(); })()`);
  const open = view => run(`layoutFixture.store.getState().setView(${js(view)})`);
  const theme = t => run(`layoutFixture.store.setState({ settings: {...layoutFixture.store.getState().settings, theme: ${js(t)}} }); layoutFixture.store.getState().applyTheme()`);
  const noDialog = `!document.querySelector('[role="dialog"]')`;
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 80 && !await run('!!window.layoutFixture'); i++) await sleep(100);
    await sleep(500);
    // Design and Memory are experimental tabs, off by default: turn them on as a person would in Settings.
    await run(`(() => { const s = layoutFixture.store.getState().settings; layoutFixture.store.setState({ settings: { ...s, experimental: { ...s.experimental, design: true, memory: true } } }); })()`);
    // The stand-in bridge answers unknown calls with null; Memory needs a list.
    await run(`void (layoutFixture.bridge.listMemory = async () => [])`);
    await run(`document.querySelector('.zones-intro button[aria-label="Close"]')?.click(); ${PAGES.map(([p]) => `localStorage.removeItem('nekko.${p}IntroSeen');`).join(' ')}`);
    for (const [page, name, cta] of PAGES) {
      await open(page); await sleep(400);
      await check(`layoutFixture.store.getState().view === ${js(page)}`, `${page}-page-opens`);
      for (const t of ['dark', 'light']) {
        await theme(t);
        for (const [width, height, label] of [[1440, 900, 'desktop'], [430, 932, 'narrow']]) {
          win.setContentSize(width, height); await sleep(250);
          await shot(`${page}-${t}-${label}-first-visit`);
          if (!baseline) await check(`document.querySelector('[data-${page}-intro]') !== null`, `${page}-${t}-${label}-guide-shows`);
        }
      }
      win.setContentSize(1440, 900); await theme('dark'); await sleep(150);
      if (baseline) continue;
      await click(cta); await sleep(100);
      await check(`${noDialog} && localStorage.getItem('nekko.${page}IntroSeen') === '1'`, `${page}-dismissal-saved`);
      await open('command'); await sleep(100); await open(page); await sleep(200);
      await check(noDialog, `${page}-return-does-not-reopen`);
      await shot(`${page}-dark-desktop-after-dismiss`);
      await click(`${name} guide`); await sleep(100);
      await check(`document.querySelector('[data-${page}-intro]') !== null`, `${page}-guide-reopens`);
      await run(`document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))`); await sleep(100);
      await check(noDialog, `${page}-escape-closes`);
      await click(`${name} guide`); await sleep(100);
      await run(`document.querySelector('[aria-label=${js(`Close ${name} guide`)}]').click()`); await sleep(100);
      await check(noDialog, `${page}-close-button-closes`);
    }
    if (!baseline) {
      await run(`location.reload()`); await sleep(1200);
      for (const [page] of PAGES) { await open(page); await sleep(200); await check(noDialog, `${page}-reload-keeps-dismissal`); }
    }
    if (report.errors.length) report.consoleErrors = report.errors.splice(0);
    report.background = { visible: win.isVisible(), focusable: win.isFocusable(), bounds: win.getBounds() };
    if (report.background.visible || report.background.focusable) throw Error('Unsafe fixture window');
  } catch (error) { report.failure = String(error.stack || error); process.exitCode = 1; }
  finally { fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); win.destroy(); app.exit(process.exitCode || 0); }
});
