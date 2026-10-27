// Always-on dictation evidence: a synthetic microphone (a tone, then silence)
// and a stubbed voiceTranscribe drive the real ChatPane composer in a hidden,
// non-focusable window. Run through layout-evidence-integration.cjs with
// NEKKO_LAYOUT_SANDBOX=voice-sandbox.cjs.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], checks: {}, errors: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const minX = Math.min(...screen.getAllDisplays().map(d => d.bounds.x)), minY = Math.min(...screen.getAllDisplays().map(d => d.bounds.y));
  const win = new BrowserWindow({ width: 900, height: 700, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: minX - 1700, y: minY - 1100, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => { report.errors.push('took focus'); });
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const shot = async name => { const f = path.join(out, name + '.png'); fs.writeFileSync(f, (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG()); report.captures.push(f); };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 50 && !(await run('!!window.layoutFixture')); i++) await sleep(200);
    await run('layoutFixture.showRetry()');
    await sleep(1200);
    // Voice on, an engine installed, and one transcript for the first segment.
    await run(`(() => {
      const f = layoutFixture; const s = f.store.getState();
      f.store.setState({ settings: { ...s.settings, voice: { enabled: true, commandsEnabled: true, silenceMs: 1200 } } });
      f.transcripts = 0;
      f.bridge.voiceStatus = async () => ({ installed: true });
      f.bridge.voiceTranscribe = async () => (f.transcripts++ === 0 ? 'Fix the bug. Nekko, send it.' : '');
      navigator.mediaDevices.getUserMedia = async () => {
        const ctx = new AudioContext(); const osc = ctx.createOscillator(); const gain = ctx.createGain(); const dest = ctx.createMediaStreamDestination();
        osc.frequency.value = 220; gain.gain.setValueAtTime(0.4, ctx.currentTime); gain.gain.setValueAtTime(0, ctx.currentTime + 1.2);
        osc.connect(gain); gain.connect(dest); osc.start();
        return dest.stream;
      };
    })()`);
    await sleep(300);
    await run(`document.querySelector('[aria-label="Start listening"]').click()`);
    await sleep(700);
    report.checks.listening = await run(`document.querySelector('[aria-label="Stop listening"]')?.getAttribute('aria-pressed')`);
    await shot('listening-dark');
    await run(`document.documentElement.dataset.theme = 'light'`); await sleep(300);
    await shot('listening-light');
    await run(`document.documentElement.dataset.theme = 'dark'`);
    // The tone stops at 1.2 s; the segment cuts 1.2 s later, is transcribed and applied.
    await sleep(3500);
    report.checks.sent = await run(`JSON.stringify(layoutFixture.lastSend ?? null)`);
    report.checks.heard = await run(`document.querySelector('[data-voice-strip]')?.textContent ?? null`);
    report.checks.toasts = await run(`JSON.stringify(layoutFixture.store.getState().toasts.map(t => t.message))`);
    await shot('after-send-dark');
    await run(`document.documentElement.dataset.theme = 'light'`); await sleep(300);
    await shot('after-send-light');
    await sleep(5000);
    report.checks.stillListeningAfter5sSilence = await run(`document.querySelector('[aria-label="Stop listening"]')?.getAttribute('aria-pressed') ?? 'off'`);
    report.checks.transcribeCalls = await run('layoutFixture.transcripts');
  } catch (e) { report.errors.push(String(e && e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.captures.length ? 0 : 1);
});
