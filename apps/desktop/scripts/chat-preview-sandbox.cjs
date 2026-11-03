const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
app.setPath('userData', path.join(out, 'profile'));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:|https:\/\/(css-loaders\.com|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com)\/)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const bounds = screen.getPrimaryDisplay().bounds;
  const narrow = process.env.NEKKO_PREVIEW_NARROW === '1';
  const win = new BrowserWindow({ width: narrow ? 390 : 900, height: narrow ? 844 : 650, show: false, focusable: false, skipTaskbar: true, x: bounds.x - 1500, y: bounds.y - 1000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const report = { files: [], checks: {}, errors: [] };
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 250)); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const shot = async name => { const f = path.join(out, name + '.png'); fs.writeFileSync(f, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.files.push(f); };
  try {
    report.checks.stage = 'load';
    await win.loadFile(path.join(out, 'index.html'));
    report.checks.stage = 'loaded';
    for (let i = 0; i < 40; i++) { let ready = false; try { ready = await run("!!document.querySelector('h2')"); } catch (e) { report.errors.push('ready: ' + String(e)); } if (ready) break; await new Promise(r => setTimeout(r, 100)); }
    report.checks.stage = 'ready';
    await new Promise(r => setTimeout(r, 650));
    await shot('chat-desktop');
    report.checks.stage = 'shot';
    report.checks.before = await run("({ buttons:document.querySelectorAll('button').length,frames:document.querySelectorAll('iframe').length })");
    if (await run("!![...document.querySelectorAll('button')].find(b=>b.textContent==='Preview')")) {
      await run("[...document.querySelectorAll('button')].filter(b=>b.textContent==='Preview')[1].click()");
      await new Promise(r => setTimeout(r, 1600));
      report.checks.after = await run("({ frames:document.querySelectorAll('iframe').length, sandbox:document.querySelector('iframe')?.getAttribute('sandbox'), referrer:document.querySelector('iframe')?.referrerPolicy, url:document.querySelector('iframe')?.getAttribute('src') })");
      await shot('chat-expanded-desktop');
      await run("[...document.querySelectorAll('button')].find(b=>b.textContent==='Close preview').click()");
      report.checks.closed = await run("document.querySelectorAll('iframe').length");
      if (report.checks.before.frames !== 0 || report.checks.after.frames !== 1 || report.checks.closed !== 0 || report.checks.after.sandbox !== 'allow-scripts allow-forms' || report.checks.after.referrer !== 'no-referrer') {
        throw Error('Chat preview interaction or isolation invariant failed');
      }
    } else if (process.env.NEKKO_LAYOUT_FRAME_SRC === 'web') {
      throw Error('Preview control missing from the changed renderer');
    }
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'chat-preview-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.errors.length ? 1 : 0);
});
