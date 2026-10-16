const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const runId = process.env.NEKKO_EVIDENCE_RUN_ID || new Date().toISOString().replace(/[:.]/g, '-');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const dir = process.env.NEKKO_EVIDENCE_DIR, kind = process.env.NEKKO_EVIDENCE_KIND;
const profile = fs.mkdtempSync(path.join(dir, 'profile-'));
app.setPath('userData', profile); app.setPath('sessionData', profile);
app.commandLine.appendSwitch('disable-background-networking'); app.commandLine.appendSwitch('force-device-scale-factor', '1');
const report = { kind, checks: [], captures: [], errors: [], blockedRequests: [], visuallyInspected: false, limitations: ['No image-view tool available: pixels checked programmatically, not visually inspected.', 'Hidden renderer evidence does not verify native OS chrome.', 'Actual notice JSX/effect in a synthetic shell, not full ChatPane integration.'] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((r, done) => { const cancel = !/^(file:|data:|blob:)/.test(r.url); if (cancel) report.blockedRequests.push(r.url); done({ cancel }); });
  session.defaultSession.setPermissionRequestHandler((w, p, done) => done(false)); session.defaultSession.setPermissionCheckHandler(() => false);
  const win = new BrowserWindow({ title: 'Isolated completion interruption evidence', width: 1440, height: 1000, useContentSize: true, x: -20000, y: -20000, show: false, focusable: false, skipTaskbar: true, webPreferences: { offscreen: true, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('Unexpected focus'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = js => win.webContents.executeJavaScript(js, true);
  const stable = () => run(`(async()=>{await document.fonts.ready;for(let i=0;i<10;i++)await new Promise(r=>requestAnimationFrame(r));return true})()`);
  const check = async (name, js) => { const result = await run(js); report.checks.push({ name, passed: !!result }); if (!result) throw Error(name); };
  const scenario = async name => { await run(`evidence.setScenario(${JSON.stringify(name)})`); await stable(); };
  const capture = async name => {
    await stable(); const image = await win.capturePage(undefined, { stayHidden: true, stayAwake: true });
    const pixels = image.toBitmap(), colors = new Set(); for (let i = 0; i < pixels.length; i += 4) colors.add(pixels.readUInt32LE(i));
    if (image.isEmpty() || colors.size < 30) throw Error('Empty or near-blank screenshot');
    const file = path.join(dir, name + '.png'); fs.writeFileSync(file, image.toPNG());
    report.captures.push({ file, size: image.getSize(), uniqueColors: colors.size, dom: await run(`({text:document.body.innerText,done:document.querySelectorAll('[data-done-row]').length,alerts:document.querySelectorAll('[role=alert]').length,notice:evidence.state.errorNotice,theme:document.documentElement.dataset.theme,width:innerWidth})`) });
  };
  const record = async label => {
    await scenario('stale');
    await check(label + ' recording starts with stale warning', `!!document.querySelector('[role=alert]')&&!document.querySelector('[data-done-row]')`);
    const basename = `completion-interruption-${runId}-${kind}-${label}-delayed`;
    const framesDir = path.join(dir, basename + '-frames'); fs.mkdirSync(framesDir);
    const motion = { basename, fps: 10, scheduledReconcileMs: 1500, frames: [], playbackInspected: false };
    report.recordings ||= []; report.recordings.push(motion);
    const start = performance.now();
    // A renderer timer supplies the delayed transcript independently of frame capture.
    await run('setTimeout(() => evidence.reconcile(), 1500); true');
    for (let i = 0; i < 40; i++) {
      await sleep(Math.max(0, start + i * 100 - performance.now()));
      const captureStartedMs = performance.now() - start;
      const image = await win.capturePage(undefined, { stayHidden: true, stayAwake: true });
      if (image.isEmpty()) throw Error('Empty recording frame');
      const png = image.toPNG();
      fs.writeFileSync(path.join(framesDir, String(i).padStart(4, '0') + '.png'), png);
      motion.frames.push({ frame: i, captureStartedMs, elapsedMs: performance.now() - start, sha256: crypto.createHash('sha256').update(png).digest('hex'), dom: await run(`({done:document.querySelectorAll('[data-done-row]').length,alerts:document.querySelectorAll('[role=alert]').length,notice:evidence.state.errorNotice})`) });
      if (win.isVisible() || win.isFocusable() || win.isFocused()) throw Error('Recording window lost background isolation');
    }
    await check(label + ' recorded delayed reconciliation outcome', `document.querySelectorAll('[data-done-row]').length===1&&document.querySelectorAll('[role=alert]').length===${kind === 'before' ? 1 : 0}`);
    if (!motion.frames.some(f => !f.dom.done && f.dom.alerts === 1) || !motion.frames.some(f => f.dom.done === 1 && f.dom.alerts === (kind === 'before' ? 1 : 0))) throw Error('Recording did not span both transcript states');
    if (new Set(motion.frames.map(f => f.sha256)).size < 2) throw Error('Recording pixels did not change');
    // Use actual capture timestamps, not a fixed input rate, so slow captures do not speed up the delay.
    const durations = motion.frames.map((frame, i) => Math.max(0.001, ((motion.frames[i + 1]?.captureStartedMs ?? frame.captureStartedMs + 100) - frame.captureStartedMs) / 1000));
    fs.writeFileSync(path.join(framesDir, 'frames.txt'), motion.frames.map((f, i) => `file '${String(i).padStart(4, '0')}.png'\nduration ${durations[i]}`).join('\n') + `\nfile '0039.png'\n`);
    motion.file = path.join(dir, '..', basename + '.mp4');
    cp.execFileSync('ffmpeg', ['-n', '-f', 'concat', '-safe', '0', '-i', path.join(framesDir, 'frames.txt'), '-vf', 'fps=10,pad=ceil(iw/2)*2:ceil(ih/2)*2', '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', motion.file], { windowsHide: true, stdio: 'pipe', timeout: 30000 });
    motion.probe = JSON.parse(cp.execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', motion.file], { windowsHide: true, encoding: 'utf8', timeout: 10000 }));
    const stream = motion.probe.streams.find(s => s.codec_type === 'video');
    if (stream?.codec_name !== 'h264' || stream.pix_fmt !== 'yuv420p' || Number(stream.nb_read_frames) < 35 || Number(motion.probe.format.duration) < 3.5) throw Error('Invalid MP4 metadata');
    cp.execFileSync('ffmpeg', ['-v', 'error', '-i', motion.file, '-f', 'null', '-'], { windowsHide: true, stdio: 'pipe', timeout: 30000 });
    motion.decodeValidated = true;
    fs.writeFileSync(path.join(dir, '..', basename + '.json'), JSON.stringify(motion, null, 2));
  };
  try {
    await win.loadFile(path.join(dir, 'index.html')); await stable();
    for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
      win.setContentSize(width, 1000); await run(`document.documentElement.dataset.theme='${theme}'`); await stable();
      const label = `${width}-${theme}`;
      await scenario('complete');
      await check(label + ' actual helper scenario assertions', `evidence.helperChecks.complete===${kind === 'before'}&&evidence.helperChecks.interrupted&&evidence.helperChecks.stale&&!evidence.helperChecks.held&&!evidence.helperChecks.streaming`);
      await check(label + ' completed turn Done and expected notice', `document.querySelectorAll('[data-done-row]').length===1&&document.querySelectorAll('[role=alert]').length===${kind === 'before' ? 1 : 0}`);
      await capture(label + '-completed');
      await scenario('interrupted');
      await check(label + ' genuine interruption retains warning without Done', `!document.querySelector('[data-done-row]')&&document.querySelector('[role=alert]').innerText.includes('Reply interrupted')`);
      await capture(label + '-interrupted');
      await scenario('stale');
      await check(label + ' delayed transcript starts inferred warning', `evidence.state.errorNotice==='This reply was interrupted before it finished.'&&!!document.querySelector('[role=alert]')`);
      await capture(label + '-delayed-stale');
      await run('evidence.reconcile()'); await stable();
      await check(label + ' delayed transcript reconciles only after fix', `document.querySelectorAll('[data-done-row]').length===1&&document.querySelectorAll('[role=alert]').length===${kind === 'before' ? 1 : 0}`);
      await capture(label + '-delayed-reconciled');
      await record(label);
      for (const name of ['stopped', 'provider']) {
        await scenario(name); const expected = name === 'stopped' ? 'Stopped' : 'Provider disconnected';
        await run('evidence.reconcile()'); await stable();
        await check(label + ' retains explicit ' + name + ' notice', `evidence.state.errorNotice===${JSON.stringify(expected)}&&!!document.querySelector('[role=alert]')`);
        await capture(label + '-' + name + '-retained');
      }
      await check(label + ' no horizontal overflow and visible content within capture', `document.documentElement.scrollWidth<=innerWidth&&[...document.querySelectorAll('[role=alert],[data-done-row]')].every(e=>{const r=e.getBoundingClientRect();return r.x>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})`);
      await check(label + ' exact viewport', `innerWidth===${width}&&innerHeight===1000`);
      report.checks.push({ name: label + ' hidden nonfocusable', passed: !win.isVisible() && !win.isFocusable() && !win.isFocused() });
    }
    report.background = { visible: win.isVisible(), focusable: win.isFocusable(), focused: win.isFocused(), bounds: win.getBounds(), electron: process.versions.electron };
  } catch (e) { report.errors.push(String(e)); report.failureDOM = await run('document.body.innerText').catch(() => 'unavailable'); }
  finally { fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(report, null, 2)); console.log(kind, JSON.stringify({ checks: report.checks.length, captures: report.captures.length, errors: report.errors })); win.destroy(); app.exit(report.errors.length || report.checks.some(c => !c.passed) ? 1 : 0); }
});
