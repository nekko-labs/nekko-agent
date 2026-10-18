// Hidden, non-focusable, off-screen window with a fresh profile per capture and no network.
const { app, BrowserWindow, session, screen, nativeTheme } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT, shots = process.env.NEKKO_SHOTS_OUT, base = !!process.env.NEKKO_TEST_REVISION;
const captureCase = process.env.NEKKO_CAPTURE_CASE;
const [state, widthText, theme] = captureCase.split('-');
const width = Number(widthText), tag = base ? 'before' : 'after';
if (!['working', 'paused'].includes(state) || ![240, 360].includes(width) || !['light', 'dark'].includes(theme)) throw new Error('Invalid capture case');
app.setPath('userData', path.join(out, `profile-${captureCase}`)); app.setPath('sessionData', path.join(out, `profile-${captureCase}`));
nativeTheme.themeSource = theme;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((r, done) => done({ cancel: !/^(file:|data:|blob:)/.test(r.url) }));
  session.defaultSession.setPermissionRequestHandler((w, p, done) => done(false));
  const left = Math.min(...screen.getAllDisplays().map((d) => d.bounds.x));
  const win = new BrowserWindow({ width, height: 600, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: left - 4000, y: -3000, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  const report = { tag, captureCase, checks: [], errors: [], visuallyInspected: false };
  win.on('focus', () => report.errors.push('Fixture took focus'));
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) report.errors.push(message); });
  const run = (s) => win.webContents.executeJavaScript(s, true);
  try {
    const expected = theme === 'light' ? { background: 'rgb(252, 252, 254)', color: 'rgb(23, 23, 29)', bgr: [254, 252, 252] } : { background: 'rgb(23, 23, 30)', color: 'rgb(236, 234, 243)', bgr: [30, 23, 23] };
    await win.loadFile(path.join(out, 'index.html'), { search: `?theme=${theme}${state === 'paused' ? '&paused' : ''}` });
    let value;
    for (let attempt = 0; attempt < 50; attempt++) {
      value = await run(`(()=>{const el=document.querySelector('[data-plan-rail-fixture]');const rows=[...document.querySelectorAll('ol li')];const style=el&&getComputedStyle(el);return {theme:document.documentElement.dataset.theme,background:style?.backgroundColor,color:style?.color,rows:rows.map(r=>({text:r.textContent,label:r.querySelector('[role="img"]')?.getAttribute('aria-label')})),overflow:document.documentElement.scrollWidth>innerWidth,focused:document.hasFocus()}})()`);
      if (value.theme === theme && value.background === expected.background && value.color === expected.color && value.rows.length === 5) break;
      await sleep(100);
    }
    report.checks.push({ name: captureCase, expected, value });
    if (value.theme !== theme || value.background !== expected.background || value.color !== expected.color) throw new Error(`Computed theme mismatch: ${JSON.stringify(value)}`);
    if (value.overflow || value.rows.length !== 5) throw new Error(`Invalid layout: ${captureCase}`);
    if (!base && value.rows.filter(r => r.label === (state === 'paused' ? 'Paused' : 'Working')).length !== 2) throw new Error(`Missing parallel statuses: ${state}`);
    await run('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))');
    // Hidden-window capture can lag the DOM. Require actual compositor pixels too.
    let img, pixel;
    for (let attempt = 0; attempt < 20; attempt++) {
      img = await win.capturePage({ x: 0, y: 0, width, height: 560 }, { stayHidden: true });
      const bitmap = img.toBitmap();
      const offset = ((img.getSize().height - 2) * img.getSize().width + img.getSize().width - 2) * 4;
      pixel = [...bitmap.subarray(offset, offset + 3)];
      if (pixel.every((v, i) => v === expected.bgr[i])) break;
      await sleep(100);
    }
    report.capturedBackgroundBgr = pixel;
    if (!pixel.every((v, i) => v === expected.bgr[i])) throw new Error(`Captured theme mismatch: ${pixel}`);
    const filename = `plan-rail-${tag}-${captureCase}-v2.png`;
    fs.writeFileSync(path.join(shots, filename), img.toPNG());
    report.filename = filename;
    report.background = { focused: win.isFocused(), visible: win.isVisible(), bounds: win.getBounds() };
  } catch (e) { report.errors.push(String(e)); }
  finally {
    fs.writeFileSync(path.join(out, `status-${captureCase}-v2.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    win.destroy(); app.exit(report.errors.length ? 1 : 0);
  }
});
