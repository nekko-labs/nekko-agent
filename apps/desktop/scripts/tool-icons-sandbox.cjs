const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Use tool-icons-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
app.setPath('sessionData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ title: 'Tool icons isolated fixture', width: 1000, height: 700, useContentSize: true, show: false, focusable: false, x: -10000, y: -10000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const report = { checks: [], errors: [], captures: [] };
  win.on('show', () => report.errors.push('Window shown'));
  win.on('focus', () => report.errors.push('Window focused'));
  const run = code => win.webContents.executeJavaScript(code, true);
  const check = async (code, label) => { if (!await run(code)) throw Error(label + ' icons=' + await run("JSON.stringify([...document.querySelectorAll('[data-tool-icon]')].map(e=>e.dataset.toolIcon))")); report.checks.push(label); };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    await win.webContents.insertCSS('.fade-in { animation: none !important; opacity: 1 !important; }');
    await run(`document.documentElement.dataset.theme=${JSON.stringify(process.env.NEKKO_THEME || 'dark')}`);
    await sleep(500);
    await run("document.querySelector('[data-purpose-group] button[aria-expanded=false]')?.click()");
    await sleep(100);
    for (const width of [1000, 460]) {
      win.setContentSize(width, 700); await sleep(250);
      await check("document.body.textContent.includes('python3 analyze.py')", 'Python call visible at ' + width);
      if (!process.env.NEKKO_BEFORE) {
        await check("['terminal','read','search','edit','check','git','web','plan','other'].every(k=>document.querySelector('[data-tool-icon='+k+']'))", 'All activity kinds render at ' + width);
        await check("!document.querySelector('[data-tool-icon] .reply-terminal-lines')", 'Transcript terminal stays static');
        await check("[...document.querySelectorAll('[data-tool-icon]')].every(e => getComputedStyle(e).color === getComputedStyle(document.querySelector('[data-tool-icon]')).color)", 'Nested and parent icons share the primary accent');
      }
      const file = path.join(out, 'tool-icons-' + width + '.png');
      fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(file);
    }
    await run("document.querySelector('button[aria-expanded=true]').click()");
    await check("document.querySelector('button[aria-expanded=false]') !== null", 'Activity group collapses');
    await run("document.querySelector('button[aria-expanded=false]').click()");
    await check("document.querySelector('button[aria-expanded=true]') !== null", 'Activity group expands');
    report.background = { visible: win.isVisible(), focused: win.isFocused(), bounds: win.getBounds() };
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  win.destroy(); app.exit(report.errors.length ? 1 : 0);
});
