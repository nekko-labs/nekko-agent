// Frames of the first-open voice video in a hidden, non-focusable window, in
// both themes, plus a GIF of the dark run. Run through layout-evidence-integration.cjs
// with NEKKO_LAYOUT_FIXTURE=voice-intro-fixture.tsx NEKKO_LAYOUT_SANDBOX=voice-intro-sandbox.cjs.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const writeGif = require('./evidence-gif.cjs');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], errors: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const minX = Math.min(...screen.getAllDisplays().map(d => d.bounds.x)), minY = Math.min(...screen.getAllDisplays().map(d => d.bounds.y));
  const win = new BrowserWindow({ width: 1280, height: 720, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: minX - 2000, y: minY - 1200, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const grab = async (width = 1280) => (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).resize({ width }).toPNG();
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 50 && !(await run('!!window.voiceIntro')); i++) await sleep(200);
    const { frames, fps } = await run('({ frames: voiceIntro.frames, fps: voiceIntro.fps })');
    // Moments worth a still: each scene's held state and the final card.
    const stills = { 'tap-on': 3, 'talk-words': 6 + 5, 'cmd-erased': 13 + 2, 'cmd-sent': 13 + 5, 'cmd-new-chat': 13 + 8, 'phone-on': 23 + 1.5, 'phone-locked': 23 + 4, privacy: 29 + 5.5 };
    for (const theme of ['dark', 'light']) {
      await run(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
      for (const [name, s] of Object.entries(stills)) {
        await run(`voiceIntro.seek(${Math.round(s * fps)})`); await sleep(250);
        const f = path.join(out, `${name}-${theme}.png`); fs.writeFileSync(f, await grab()); report.captures.push(f);
      }
    }
    await run(`document.documentElement.dataset.theme = 'dark'`);
    const gif = [];
    for (let f = 0; f < frames; f += 10) { await run(`voiceIntro.seek(${f})`); await sleep(60); gif.push(await grab(480)); }
    const file = path.join(out, 'voice-intro.gif'); writeGif(file, gif, 33); report.captures.push(file);
  } catch (e) { report.errors.push(String(e && e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.captures.length ? 0 : 1);
});
