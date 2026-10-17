const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const dir = process.env.NEKKO_EVIDENCE_DIR, kind = process.env.NEKKO_EVIDENCE_KIND;
app.commandLine.appendSwitch('force-device-scale-factor', '1');
const profile = fs.mkdtempSync(path.join(dir, 'profile-')); app.setPath('userData', profile); app.setPath('sessionData', profile);
const report = { kind, captures: [], metrics: {}, errors: [] };
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((r, done) => done({ cancel: !/^(file:|data:|blob:)/.test(r.url) }));
  session.defaultSession.setPermissionRequestHandler((w, p, d) => d(false));
  const left = Math.min(...screen.getAllDisplays().map(d => d.bounds.x));
  const win = new BrowserWindow({ width: 1100, height: 560, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: left - 5000, y: -3000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const shot = async name => { await sleep(500); const img = await win.capturePage(undefined, { stayHidden: true }); fs.writeFileSync(path.join(dir, name + '.png'), img.toPNG()); report.captures.push(name); };
  const measure = () => run(`(()=>{const r=s=>{const e=document.querySelector(s);if(!e)return null;const b=e.getBoundingClientRect();return {top:Math.round(b.top*10)/10,bottom:Math.round(b.bottom*10)/10,height:Math.round(b.height*10)/10}};
    const strip=document.querySelector('[aria-label="Chat actions and information"]').getBoundingClientRect(), deck=document.querySelector('.pr-action-deck').getBoundingClientRect(), toggle=document.querySelector('.pr-deck-toggle').getBoundingClientRect(), card=document.querySelector('[data-pr-actions]');
    return {titlebar:r('.titlebar'),mark:r('.titlebar-mark'),heading:r('.titlebar h1'),toolbar:r('[data-toolbar-standin]'),board:r('[data-board-top]'),deck:{top:deck.top,bottom:deck.bottom},strip:{top:strip.top},toggleTop:toggle.top,cardBottom:card?card.getBoundingClientRect().bottom:null,cardVisible:card?getComputedStyle(card.closest('.pr-deck-reveal')).opacity:null}})()`);
  try {
    await win.loadFile(path.join(dir, 'index.html')); win.showInactive();
    for (let i = 0; i < 40 && !(await run("!!document.querySelector('.pr-deck-toggle')&&!!document.querySelector('[data-toolbar-standin]')")); i++) await sleep(150);
    await run('document.fonts.ready');
    for (const theme of ['dark', 'light']) {
      await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      // Expanded (default for an open PR).
      await sleep(400); report.metrics[theme + '-expanded'] = await measure(); await shot(theme + '-expanded');
      await run("document.querySelector('.pr-deck-toggle').click()"); await sleep(500);
      report.metrics[theme + '-collapsed'] = await measure(); await shot(theme + '-collapsed');
      await run("document.querySelector('.pr-deck-toggle').click()"); await sleep(500);
    }
    // Motion: frames of the expand transition (dark).
    await run(`document.documentElement.dataset.theme='dark'`); await run("document.querySelector('.pr-deck-toggle').click()"); await sleep(500);
    fs.mkdirSync(path.join(dir, 'motion'), { recursive: true });
    await run("document.querySelector('.pr-deck-toggle').click()");
    for (let i = 0; i < 10; i++) { fs.writeFileSync(path.join(dir, 'motion', String(i).padStart(2, '0') + '.png'), (await win.capturePage({ x: 0, y: 300, width: 900, height: 260 }, { stayHidden: true })).toPNG()); await sleep(30); }
    report.background = { focused: win.isFocused(), focusable: win.isFocusable() };
  } catch (e) { report.errors.push(String(e && e.stack || e)); }
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ kind, metrics: report.metrics['dark-expanded'], collapsed: report.metrics['dark-collapsed'], errors: report.errors }, null, 1));
  win.destroy(); app.exit(report.errors.length ? 1 : 0);
});
