// Synthetic evidence for tool-step elapsed times and swipe-left message times;
// never connects to the user's host or profile. Launched through
// chat-search-integration.cjs with NEKKO_SANDBOX=chat-timing-sandbox.cjs
// (NEKKO_TEST_REVISION=<rev> for "before"). Hidden, non-focusable, off-screen;
// renderer input only (sendInputEvent), no OS input.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through chat-search-integration.cjs');
const base = !!process.env.NEKKO_TEST_REVISION;
const dir = path.join(out, base ? 'timing-before' : 'timing-after');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
app.setPath('userData', path.join(dir, 'profile'));
app.setPath('sessionData', path.join(dir, 'profile'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((request, done) => done({ cancel: !/^(file:|data:|blob:)/.test(request.url) }));
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, done) => done(false));
  const left = Math.min(...screen.getAllDisplays().map(d => d.bounds.x));
  // macOS moves a shown off-screen window back onto a display, so it is never shown.
  const win = new BrowserWindow({
    width: 1100, height: 760, useContentSize: true, show: false, focusable: false, skipTaskbar: true,
    x: left - 3000, y: -2000, title: 'Synthetic chat timing verification',
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  const report = { checks: [], errors: [], measures: {} };
  win.on('focus', () => report.errors.push('Fixture took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push('console: ' + e.message); });
  const run = source => win.webContents.executeJavaScript(source, true);
  const check = (name, ok) => report.checks.push({ name, passed: !!ok });
  const capture = async name => fs.writeFileSync(path.join(dir, name + '.png'), (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG());
  try {
    await win.loadFile(path.join(out, 'index.html'));
    await sleep(1500);
    await run('integration.reset()'); await sleep(1500);
    // Open the last run of working steps so its rows show.
    const target = await run(`(()=>{
      const groups=[...document.querySelectorAll('[data-transcript-scroll] button[aria-expanded="false"]')].filter(b=>/Worked on/.test(b.textContent));
      const g=groups[groups.length-1]; if(!g) return null; g.scrollIntoView({block:'center'});
      const r=g.getBoundingClientRect(); return {x:Math.round(r.left+20),y:Math.round(r.top+r.height/2)};
    })()`);
    if (target) for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: target.x, y: target.y, button: 'left', clickCount: 1 });
    await sleep(400);
    const elapsed = await run(`[...document.querySelectorAll('[data-tool-elapsed]')].map(e=>e.textContent)`);
    report.measures.elapsed = elapsed;
    if (!base) check('each opened tool row starts with its elapsed time (1.0s in the fixture)', elapsed.length > 0 && elapsed.every(t => t === '1.0s'));
    await capture('tool-elapsed');

    // A trackpad swipe left: horizontal wheel input over the transcript.
    const mid = await run(`(()=>{const r=document.querySelector('[data-transcript-scroll]').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);
    const swipe = async () => { for (let i = 0; i < 8; i++) { win.webContents.sendInputEvent({ type: 'mouseWheel', x: mid.x, y: mid.y, deltaX: -12, deltaY: 0, canScroll: true }); await sleep(16); } };
    const reveal = () => run(`(()=>{const s=document.querySelector('[data-transcript-scroll]');const l=s.querySelector('.vt-list');const row=s.querySelector('.vt-row[data-vt-stamp]');return {reveal:s.style.getPropertyValue('--vt-reveal'),opacity:row?getComputedStyle(row,'::after').opacity:null,stamp:row?row.dataset.vtStamp:null,transform:l?l.style.transform:null,scrollLeft:s.scrollLeft}})()`);
    await swipe();
    let during = await reveal();
    // Electron's wheel sign is inverted relative to a DOM WheelEvent on some builds; try the other way once.
    if (!during.reveal || during.reveal === '0px') {
      for (let i = 0; i < 8; i++) { win.webContents.sendInputEvent({ type: 'mouseWheel', x: mid.x, y: mid.y, deltaX: 12, deltaY: 0, canScroll: true }); await sleep(16); }
      during = await reveal();
    }
    report.measures.during = during;
    await capture('swipe-held');
    await sleep(600);
    const after = await reveal();
    report.measures.after = after;
    await capture('swipe-released');
    if (!base) {
      check('swiping left slides the rows and shows their times', parseFloat(during.reveal) > 0 && Number(during.opacity) > 0 && !!during.stamp && /translateX\(-/.test(during.transform));
      check('letting go springs the rows back and hides the times', (after.reveal === '0px' || after.reveal === '') && Number(after.opacity) === 0 && !after.transform);
      check('the swipe never scrolls the transcript sideways', during.scrollLeft === 0 && after.scrollLeft === 0);
    }
    report.success = !report.errors.some(e => /focus/.test(e)) && (base || report.checks.every(c => c.passed));
  } catch (error) {
    report.errors.push(String(error && error.stack || error)); report.success = false;
  } finally {
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ dir, success: report.success, checks: report.checks, errors: [...new Set(report.errors)].slice(0, 6), measures: report.measures }, null, 2));
    win.destroy(); app.exit(report.success ? 0 : 1);
  }
});
