// Synthetic renderer-only evidence. No host, user profile, OS input or network.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch with panel-metrics-integration.cjs');
const base = !!process.env.NEKKO_TEST_REVISION;
const dir = path.join(out, base ? 'before' : 'after');
fs.mkdirSync(dir, { recursive: true });
const profile = fs.mkdtempSync(path.join(dir, 'profile-'));
app.setPath('userData', profile);
app.setPath('sessionData', profile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const report = { revision: process.env.NEKKO_TEST_REVISION || 'working-tree', checks: [], errors: [], captures: [], visuallyInspected: false, blockedNetwork: [] };
  session.defaultSession.webRequest.onBeforeRequest((r, done) => {
    const cancel = !/^(file:|data:|blob:)/.test(r.url);
    if (cancel) report.blockedNetwork.push(r.url);
    done({ cancel });
  });
  session.defaultSession.setPermissionRequestHandler((_c, _p, done) => done(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  const left = Math.min(...screen.getAllDisplays().map(d => d.bounds.x));
  const win = new BrowserWindow({ width: 1920, height: 1000, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: left - 4500, y: -3000, title: 'Isolated panel metrics verification', webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('Fixture took focus'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const check = async (name, source) => { report.checks.push({ name, passed: !!await run(source) }); };
  const capture = async name => {
    const file = path.join(dir, name + '.png');
    const image = await win.capturePage(undefined, { stayHidden: true, stayAwake: false });
    if (image.isEmpty()) throw Error('Empty capture: ' + name);
    fs.writeFileSync(file, image.toPNG()); report.captures.push({ file, size: image.getSize() });
  };
  const click = id => run(`document.querySelector('[data-grid-cell="chat:${id}"] [data-plan-toggle]')?.click()`);
  const pressed = id => `document.querySelector('[data-grid-cell="chat:${id}"] [data-plan-toggle]')?.getAttribute('aria-pressed')`;
  try {
    await win.loadFile(path.join(out, 'index.html')); win.showInactive(); await sleep(1000);
    for (const width of [1920, 900]) for (const theme of ['dark', 'light']) {
      win.setContentSize(width, 1000);
      await run("integration.reset({plan:true,dockAll:true});");
      await sleep(1300);
      await run(`document.documentElement.dataset.theme='${theme}'`); await sleep(400);
      const label = `${width === 1920 ? 'wide' : 'narrow'}-${theme}`;
      await capture(label + '-closed');
      await check(label + ': two real chat panes', "document.querySelectorAll('[data-grid-cell^=\"chat:\"]').length===2");
      await check(label + ': named GPU utilization', "(()=>{const h=document.querySelector('.monitors-dock__hardware');return !!h&&h.querySelector('[aria-label=\"GPU 1: Fixture RTX 5090\"]')?.getAttribute('aria-valuenow')==='37'&&h.querySelector('[aria-label=\"GPU 2: Fixture Intel Arc\"]')?.getAttribute('aria-valuenow')==='81'})()");
      for (const pct of [59,60,84,85,100]) {
        const tone = pct < 60 ? 'success' : pct < 85 ? 'warning' : 'danger';
        await check(`${label}: gauge ${pct}% uses ${tone} full background`, `(()=>{const e=document.querySelector('[data-gauge-pct="${pct}"] .context-bar');return !!e&&e.style.background.includes('var(--${tone})')&&e.style.background.includes('12%')&&e.querySelector('[aria-hidden]')?.style.background.includes('var(--${tone})')})()`);
      }
      report[label] = await run("({buttons:[...document.querySelectorAll('[data-plan-toggle]')].map(e=>({pressed:e.getAttribute('aria-pressed'),rect:e.getBoundingClientRect().toJSON()})),gauges:[...document.querySelectorAll('[data-gauge-pct]')].map(e=>({pct:e.dataset.gaugePct,background:getComputedStyle(e.querySelector('.context-bar')).backgroundColor})),hardware:document.querySelector('.monitors-dock__hardware')?.innerText})");
      if (width === 1920) {
        await check(label + ': two plan buttons', "document.querySelectorAll('[data-plan-toggle]').length===2");
        await click('alpha'); await sleep(500);
        await check(label + ': alpha opens without beta', `${pressed('alpha')}==='true'&&${pressed('beta')}==='false'`);
        await capture(label + '-alpha-open');
        await click('beta'); await sleep(500);
        await check(label + ': both plans open', `${pressed('alpha')}==='true'&&${pressed('beta')}==='true'`);
        await click('alpha'); await sleep(500);
        await check(label + ': alpha closes without beta', `${pressed('alpha')}==='false'&&${pressed('beta')}==='true'`);
        await capture(label + '-beta-open');
        // Record captured renderer frames at their actual measured timestamps,
        // not OS screenshots or a claimed desktop-focus recording.
        const frames = path.join(dir, label + '-frames'); fs.mkdirSync(frames, { recursive: true });
        await run('integration.reset({plan:true,dockAll:true})'); await sleep(1000);
        const times = []; const start = Date.now(); let opened = false, closed = false;
        while (Date.now() - start < 2400) {
          const elapsed = Date.now() - start;
          if (elapsed >= 400 && !opened) { await click('alpha'); opened = true; }
          if (elapsed >= 1400 && !closed) { await click('alpha'); closed = true; }
          times.push(Date.now() - start);
          fs.writeFileSync(path.join(frames, `${times.length}.png`), (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG());
          await sleep(65);
        }
        const concat = times.map((t,i) => `file '${i+1}.png'\nduration ${((times[i+1] ?? 2400)-t)/1000}`).join('\n') + `\nfile '${times.length}.png'\n`;
        fs.writeFileSync(path.join(frames,'frames.txt'),concat);
        cp.execFileSync('ffmpeg', ['-y','-f','concat','-safe','0','-i',path.join(frames,'frames.txt'),'-vf','fps=15,pad=ceil(iw/2)*2:ceil(ih/2)*2','-c:v','libx264','-pix_fmt','yuv420p',path.join(dir,label+'-plan-motion.mp4')], { windowsHide: true, stdio:'pipe' });
        report[label].motion = { frames: times.length, timestampsMs: times, file: path.join(dir,label+'-plan-motion.mp4') };
      } else {
        await check(label + ': narrow rails safely folded', "!document.querySelector('[aria-label=\"Plan and sub-agents\"]')");
      }
    }
    report.background = { focused: win.isFocused(), bounds: win.getBounds(), displays: screen.getAllDisplays().map(d=>d.bounds) };
    if (win.isFocused()) throw Error('Fixture focused');
    report.success = !report.errors.length && (base || report.checks.every(c=>c.passed));
  } catch (e) { report.errors.push(String(e)); report.success = false; }
  finally {
    win.destroy();
    fs.writeFileSync(path.join(dir,'status.json'),JSON.stringify(report,null,2));
    // Electron still owns profile handles. The parent removes it after exit.
    console.log(JSON.stringify({dir,success:report.success,checks:report.checks.length,failed:report.checks.filter(c=>!c.passed).map(c=>c.name),errors:report.errors},null,2));
    app.exit(report.success ? 0 : 1);
  }
});
