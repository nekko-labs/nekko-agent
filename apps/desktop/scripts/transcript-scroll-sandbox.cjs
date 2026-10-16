// Synthetic transcript-scroll evidence; never connects to the user's host or profile.
// Launched through transcript-scroll-integration.cjs (NEKKO_TEST_REVISION=<rev> for "before").
// Drives real wheel events (renderer input, no OS input) up a long chat and back
// down, and records, every frame and every scroll event, where the rendered rows
// sit on screen, so "the content moved against the wheel" is measured directly.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through transcript-scroll-integration.cjs');
const base = !!process.env.NEKKO_TEST_REVISION;
const dir = path.join(out, base ? 'before' : 'after');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
app.setPath('userData', path.join(dir, 'profile'));
app.setPath('sessionData', path.join(dir, 'profile'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// dirn 1 is up (Chromium's positive wheel deltaY scrolls up), -1 is down.
// Scrolling up, the content moves down the screen; a "jump" is any sample where
// a row on screen moved the other way by more than a pixel. Rows rendered off
// screen (the overscan) are not what the reader sees and are not tracked: when
// one is measured, the rows below it, on screen, are held still and it moves.
function analyse(trace, frames, dirn, viewHeight) {
  let jumps = 0, againstPx = 0;
  for (let i = 1; i < trace.length; i++) {
    const a = trace[i - 1].rows, b = trace[i].rows;
    // The row nearest the middle of the viewport, as the reader last saw it.
    const key = Object.keys(a).filter(k => k in b && a[k] > -200 && a[k] < viewHeight).sort((x, y) => Math.abs(a[x] - viewHeight / 2) - Math.abs(a[y] - viewHeight / 2))[0];
    if (!key) continue;
    const moved = b[key] - a[key];
    if (dirn > 0 ? moved < -1 : moved > 1) { jumps++; againstPx += Math.abs(moved); }
  }
  const sorted = frames.slice(1).sort((x, y) => x - y);
  const pct = p => sorted.length ? +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(1) : 0;
  return { samples: trace.length, jumps, againstPx: Math.round(againstPx), frameP50: pct(0.5), frameP95: pct(0.95), frameMax: pct(1), longFrames: sorted.filter(f => f > 25).length, frames: sorted.length };
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((request, done) => done({ cancel: !/^(file:|data:|blob:)/.test(request.url) }));
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, done) => done(false));
  const left = Math.min(...screen.getAllDisplays().map(d => d.bounds.x));
  const win = new BrowserWindow({
    width: 1100, height: 720, useContentSize: true, show: false, focusable: false, skipTaskbar: true,
    x: left - 3000, y: -2000, title: 'Synthetic transcript scroll verification',
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  const report = { checks: [], errors: [], measures: {} };
  win.on('focus', () => report.errors.push('Fixture took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push('console: ' + e.message); });
  const run = source => win.webContents.executeJavaScript(source, true);
  const check = (name, ok) => report.checks.push({ name, passed: !!ok });
  const capture = async name => { await sleep(300); fs.writeFileSync(path.join(dir, name + '.png'), (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG()); };
  const point = () => run("(()=>{const r=document.querySelector('[data-transcript-scroll]').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()");
  const state = () => run("(()=>{const s=document.querySelector('[data-transcript-scroll]');return {top:Math.round(s.scrollTop),max:Math.round(s.scrollHeight-s.clientHeight)}})()");
  const gapOf = s => s.max - s.top;
  // `ticks` wheel notches of 100 px, `gap` ms apart, like a mouse wheel spun steadily.
  const wheel = async (dirn, ticks, gap) => {
    const p = await point();
    await run('integration.startTrace()');
    for (let i = 0; i < ticks; i++) { win.webContents.sendInputEvent({ type: 'mouseWheel', x: p.x, y: p.y, deltaX: 0, deltaY: 100 * dirn, canScroll: true }); await sleep(gap); }
    await sleep(700);
    const { trace, frames } = await run('integration.stopTrace()');
    return analyse(trace, frames, dirn, await run("document.querySelector('[data-transcript-scroll]').clientHeight"));
  };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    win.showInactive();
    await sleep(1500);
    // Both motion settings, emulated so the result does not depend on the OS:
    // the app's reduced-motion CSS only applies when it is on.
    win.webContents.debugger.attach('1.3');
    const passes = [['reduce', 'dark'], ['reduce', 'light'], ['no-preference', 'dark'], ['no-preference', 'light']];
    for (const [motion, t0] of passes) {
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: motion }] });
      const t = `${t0}-${motion}`;
      report.measures[`reducedMotion-${t}`] = await run("matchMedia('(prefers-reduced-motion: reduce)').matches");
      await run('integration.reset()'); await sleep(1500);
      await run(`document.documentElement.dataset.theme='${t0}'`); await sleep(300);
      const start = await state();
      report.measures[`start-${t}`] = start;
      check(`opens at the bottom (${t})`, gapOf(start) < 2);
      await capture(`bottom-start-${t}`);
      // Up through rows that have never been measured, then straight back down.
      const up = await wheel(1, 60, 16);
      const mid = await state();
      report.measures[`up-${t}`] = up;
      report.measures[`mid-${t}`] = mid;
      check(`wheel up actually scrolls up (${t})`, gapOf(mid) > 3000);
      check(`wheel up never moves the content against the wheel (${t})`, up.jumps === 0);
      await capture(`mid-${t}`);
      const down = await wheel(-1, 140, 16);
      const end = await state();
      report.measures[`down-${t}`] = down;
      report.measures[`end-${t}`] = end;
      check(`wheel down from the middle reaches the bottom (${t})`, gapOf(end) < 2);
      check(`wheel down never moves the content against the wheel (${t})`, down.jumps === 0);
      check(`no long frames while scrolling (${t})`, up.longFrames + down.longFrames === 0);
      await capture(`bottom-end-${t}`);
      // Sitting at the bottom, nudge up a little and come straight back.
      const nudgeUp = await wheel(1, 3, 40);
      const nudgeDown = await wheel(-1, 6, 40);
      const after = await state();
      report.measures[`nudge-${t}`] = { up: nudgeUp, down: nudgeDown, end: after };
      check(`a small nudge up and back returns to the bottom (${t})`, gapOf(after) < 2 && nudgeDown.jumps === 0);
    }
    report.success = !report.errors.some(e => /focus/.test(e)) && (base || report.checks.every(c => c.passed));
  } catch (error) {
    report.errors.push(String(error)); report.success = false;
  } finally {
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ dir, success: report.success, failed: report.checks.filter(c => !c.passed).map(c => c.name), errors: [...new Set(report.errors)].slice(0, 6), errorCount: report.errors.length, measures: report.measures }, null, 2));
    win.destroy(); app.exit(report.success ? 0 : 1);
  }
});
