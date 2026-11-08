// Use with layout-evidence-integration.cjs. Hidden isolated renderer; no host.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const writeGif = require('./evidence-gif.cjs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], errors: [], checks: {} };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1100, height: 1000, useContentSize: true, show: false, focusable: false, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false, offscreen: true } });
  win.on('focus', () => report.errors.push('took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const shot = async name => { const file = path.join(out, name + '.png'); fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(file); };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    await sleep(1000);
    for (const theme of ['dark', 'light']) {
      await run(`document.documentElement.dataset.theme = '${theme}'`);
      for (const width of [1100, 390]) {
        win.setContentSize(width, 1000); await sleep(250);
        await shot(`overview-${theme}-${width}`);
        if (await run('!!window.scheduledDemo')) {
          await run('scheduledDemo.showVideo(true)'); await sleep(250);
          for (const frame of [60, 270, 480, 720, 930, 1110]) {
            await run(`scheduledDemo.seek(${frame})`); await sleep(100);
            await shot(`scene-${theme}-${width}-${frame}`);
            const fits = await run(`Array.from(document.querySelectorAll('[data-demo-fit]')).every(e => e.scrollWidth <= e.clientWidth + 1 && e.scrollHeight <= e.clientHeight + 1)`);
            if (!fits) throw Error(`Text overflow: ${theme} ${width} frame ${frame}`);
          }
          report.checks[`${theme}-${width}-no-page-overflow`] = await run('document.documentElement.scrollWidth <= innerWidth');
          await run('scheduledDemo.showVideo(false)'); await sleep(250);
        }
      }
    }
    if (await run('!!window.scheduledDemo')) {
      win.setContentSize(1100, 1000);
      await run('scheduledDemo.showVideo(true)'); await sleep(250);
      await run("document.documentElement.dataset.theme = 'dark'; scheduledDemo.seek(0); scheduledDemo.play()");
      await sleep(600);
      report.checks.playbackAdvances = await run('scheduledDemo.frame() > 0');
      await run('scheduledDemo.pause()');
      const paused = await run('scheduledDemo.frame()'); await sleep(250);
      report.checks.pauseHolds = paused === await run('scheduledDemo.frame()');
      const rect = await run(`(() => { const r = document.querySelector('[aria-label="Scheduled Tasks video player"]').getBoundingClientRect(); return { x: Math.ceil(r.x), y: Math.ceil(r.y), width: Math.floor(r.width), height: Math.floor(r.height) }; })()`);
      const motion = [];
      for (let frame = 600; frame < 870; frame += 3) {
        await run(`scheduledDemo.seek(${frame})`); await sleep(40);
        motion.push((await win.capturePage(rect, { stayHidden: true })).resize({ width: 640 }).toPNG());
      }
      const gif = path.join(out, 'scheduled-tasks-motion.gif');
      writeGif(gif, motion, 10); report.captures.push(gif);
      await run("document.querySelector('[data-demo-transcript]').open = true");
      report.checks.transcript = await run("document.querySelector('[data-demo-transcript]').innerText.includes('Keep Nekko running')");
    }
    report.checks.hidden = !win.isVisible() && !win.isFocused();
    if (Object.values(report.checks).some(v => !v)) throw Error('A check failed');
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.errors.length ? 1 : 0);
});
