// Evidence for tool calls grouped by purpose (spec/chat/tool-calls-grouped-by-purpose.md):
// the real ActivityGroup in a hidden, off-screen, non-focusable window. Launch
// through tool-groups-integration.cjs (NEKKO_TEST_REVISION=<rev> for the "before").
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const out = process.env.NEKKO_COMPONENT_OUT;
if (!out) throw Error('Launch through tool-groups-integration.cjs');
const kind = process.env.NEKKO_TEST_REVISION ? 'before' : 'after';
const runDir = path.join(out, kind);
fs.mkdirSync(runDir, { recursive: true });
app.setPath('userData', path.join(runDir, 'profile'));
app.setPath('sessionData', path.join(runDir, 'profile'));
const report = { checks: [], errors: [], captures: [], visuallyInspected: false };
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, done) => done(false));
  const win = new BrowserWindow({ width: 900, height: 1400, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -10000, y: -10000, title: `Tool groups ${kind} · isolated`, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.on('show', () => { report.errors.push('Verification window became visible'); process.exitCode = 1; });
  win.on('focus', () => { report.errors.push('Verification window took OS focus'); process.exitCode = 1; });
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = code => win.webContents.executeJavaScript(code, true);
  // Fixed expressions only: never interpolate labels into executable code.
  const rects = {
    turn: "(() => { const r = document.querySelector('[data-scene=turn]').getBoundingClientRect(); return { x: Math.floor(r.x) - 12, y: Math.floor(r.y) - 10, width: Math.ceil(r.width) + 24, height: Math.ceil(r.height) + 20 }; })()",
    failing: "(() => { const r = document.querySelector('[data-scene=failing]').getBoundingClientRect(); return { x: Math.floor(r.x) - 12, y: Math.floor(r.y) - 10, width: Math.ceil(r.width) + 24, height: Math.ceil(r.height) + 20 }; })()",
    live: "(() => { const r = document.querySelector('[data-scene=live]').getBoundingClientRect(); return { x: Math.floor(r.x) - 12, y: Math.floor(r.y) - 10, width: Math.ceil(r.width) + 24, height: Math.max(150, Math.ceil(r.height) + 20) }; })()",
  };
  const clicks = {
    turn: "document.querySelector('[data-scene=turn] button').click()",
    failing: "document.querySelector('[data-scene=failing] button').click()",
    explore: "(() => { const b = [...document.querySelectorAll('[data-scene=turn] button')].find(b => b.textContent.includes('Looked through the code')); if (!b) throw Error('Missing explore group'); b.click(); })()",
  };
  const shot = async (scene, name) => {
    await sleep(250);
    const rect = await run(rects[scene]);
    const file = path.join(runDir, name + '.png');
    fs.writeFileSync(file, (await win.capturePage(rect, { stayHidden: true, stayAwake: false })).toPNG());
    report.captures.push(file);
  };
  const text = scene => run(`document.querySelector('[data-scene=${scene === 'turn' ? 'turn' : scene === 'failing' ? 'failing' : 'live'}]').textContent`);
  try {
    await win.loadFile(path.join(out, 'index.html')); await sleep(650);
    if (!await run("document.body.textContent.includes('Finished turn')")) throw Error('Fixture did not mount: ' + await run('document.body.textContent.slice(0,500)'));
    report.checks.push('real ActivityGroup mounted');
    for (const theme of ['light', 'dark']) {
      await run(`document.documentElement.dataset.theme='${theme === 'light' ? 'light' : 'dark'}'`);
      await shot('turn', `${theme}-turn-collapsed`);
      await run(clicks.turn); await sleep(150);
      await shot('turn', `${theme}-turn-open`);
      if (kind === 'after') {
        const t = await text('turn');
        for (const want of ["Read the project's guidance", 'Looked through the code', 'Edited 3 files', 'Run the shared tests and 1 more', 'Committed and pushed']) {
          if (!t.includes(want)) throw Error(`Missing group headline ${want}: ${t}`);
        }
        await run(clicks.explore); await sleep(150);
        await shot('turn', `${theme}-turn-group-open`);
        await run(clicks.explore); await sleep(100);
        report.checks.push(`${theme}: purpose groups and headlines`);
      }
      await run(clicks.turn); await sleep(100);
      await shot('failing', `${theme}-failing-collapsed`);
      await run(clicks.failing); await sleep(150);
      await shot('failing', `${theme}-failing-open`);
      if (kind === 'after' && !(await text('failing')).includes('1 failed')) throw Error('Failure not marked');
      await run(clicks.failing); await sleep(100);
    }
    // The live turn filling, one call at a time.
    await run("document.documentElement.dataset.theme='light'");
    const motion = path.join(runDir, 'motion'); fs.mkdirSync(motion, { recursive: true });
    const liveRect = await run(rects.live);
    liveRect.height = 190;
    let frame = 0;
    for (let step = 0; step < 7; step++) {
      for (let f = 0; f < 8; f++) {
        fs.writeFileSync(path.join(motion, `${String(frame++).padStart(3, '0')}.png`), (await win.capturePage(liveRect, { stayHidden: true, stayAwake: false })).toPNG());
        await sleep(90);
      }
      await run('window.__advance()');
    }
    if (kind === 'after' && !(await text('live')).includes('Looking through the code')) throw Error('Live group headline missing: ' + await text('live'));
    cp.execFileSync('ffmpeg', ['-y', '-framerate', '10', '-i', path.join(motion, '%03d.png'), '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(runDir, 'live.mp4')], { stdio: 'ignore', windowsHide: true });
    report.checks.push('live recording');
    report.background = { visible: win.isVisible(), focused: win.isFocused() };
    if (win.isVisible() || win.isFocused()) report.errors.push('Background verification visibility/focus invariant failed');
    report.success = !report.errors.length;
  } catch (e) { report.errors.push(String(e)); report.success = false; }
  finally { fs.writeFileSync(path.join(runDir, 'status.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ runDir, ...report }, null, 2)); win.destroy(); app.exit(report.success ? 0 : 1); }
});
