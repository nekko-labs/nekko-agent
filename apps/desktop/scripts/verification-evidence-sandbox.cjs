// Hidden full-app evidence; isolated profile, stubbed files, no network or OS input.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Use layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'verification-profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], metrics: {}, errors: [] };
// Synthetic illustration content: fixture only, never claimed as real UI evidence.
const svg = side => `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="240"><rect width="600" height="240" fill="${side === 'Before' ? '#334155' : '#0f766e'}"/><text x="30" y="130" font-size="30" fill="white">${side}: fixture screenshot</text></svg>`;
const reply = 'Updated the example surface. These are fixture illustrations for testing the comparison UI.\n\n![Before: Example surface](C:/demo/before.svg)\n![After: Example surface](C:/demo/after.svg)\n\n**Verified**\nCaptured fixture images only; not approved.\n\n**Next step**\nCompare both screenshots and review the visual change.';
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:|about:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const displays = screen.getAllDisplays();
  const win = new BrowserWindow({ width: 1440, height: 1000, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: Math.min(...displays.map(d => d.bounds.x)) - 1700, y: -1500, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const run = code => win.webContents.executeJavaScript(code, true);
  win.on('focus', () => report.errors.push('Window received focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 80 && !await run('!!window.layoutFixture && !!document.querySelector("[data-command-wall]")'); i++) await sleep(100);
    await run(`(() => {
      const f = window.layoutFixture;
      window.evidenceOpened = [];
      f.store.setState({ openFilePane: (p, s) => window.evidenceOpened.push({ path:p, session:s }) });
      f.bridge.readFile = async p => ({ content: p.endsWith('before.svg') ? ${JSON.stringify(svg('Before'))} : ${JSON.stringify(svg('After'))}, binary: false, truncated: false });
      const s = f.records[0];
      s.messages = [{ id:'u1', role:'user', content:'Update this surface.', createdAt:Date.now()-60000 }, { id:'a1', role:'assistant', content:${JSON.stringify(reply)}, createdAt:Date.now()-30000 }];
      f.putCachedSession(s); f.store.getState().openChatPane(s.id);
      const st = f.store.getState(); f.store.setState({ settings:{...st.settings,commandWall:{...(st.settings.commandWall||{}),dock:{show:false}}} });
    })()`);
    await sleep(500);
    await run(`(() => { const hit = [...document.querySelectorAll('button,[role="button"],a,[tabindex]')].find(e => e.textContent.includes('Persist quota history') || e.textContent.includes('Persist qu')); hit?.click(); })()`);
    await sleep(2500);
    await win.webContents.insertCSS('*,*::before,*::after{animation:none!important;transition:none!important}');
    for (const theme of ['dark','light']) for (const width of [1440,720]) {
      win.setContentSize(width,1000);
      await run(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
      await sleep(600);
      for (const place of ['inline','next-step']) {
        await run(`(document.querySelector('[data-verification-evidence="${place}"]') || document.querySelector('[data-chat-surface]'))?.scrollIntoView({block:'center'})`);
        await sleep(400);
        const file = path.join(out, `${theme}-${width}-${place}.png`);
        fs.writeFileSync(file, (await win.capturePage(undefined,{stayHidden:true})).toPNG()); report.captures.push(file);
      }
    }
    report.metrics = await run(`(() => { const panels=[...document.querySelectorAll('[data-verification-evidence]')]; const images=panels.map(p=>({place:p.dataset.verificationEvidence, images:p.querySelectorAll('img').length})); const button=document.querySelector('[data-verification-evidence="next-step"] button'); button?.click(); return {images,opened:window.evidenceOpened}; })()`);
    if (win.isVisible() || win.isFocused()) report.errors.push('Window visible or focused');
  } catch (e) { report.errors.push(String(e.stack || e)); }
  finally { fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2)); win.destroy(); app.quit(); }
});
