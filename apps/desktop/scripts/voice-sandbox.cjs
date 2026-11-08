// Always-on dictation evidence: a synthetic microphone (a tone, then silence)
// and a stubbed voiceTranscribe drive the real ChatPane composer in a hidden,
// non-focusable window. Run through layout-evidence-integration.cjs with
// NEKKO_LAYOUT_SANDBOX=voice-sandbox.cjs.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
// A fresh profile each run: a draft left in the last run's storage would ride along into the send.
fs.rmSync(path.join(out, 'profile'), { recursive: true, force: true });
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], checks: {}, errors: [] };
// Where the island sits, and anything in the composer it overlaps.
const islandLayout = `(() => {
  const box = el => el.getBoundingClientRect();
  const hit = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const island = document.querySelector('[data-voice-island]');
  const a = box(island);
  const others = [...island.parentElement.children].filter(el => el !== island).concat([island.closest('.composer').querySelector('[contenteditable]')]);
  const mic = box(island.querySelector('button'));
  return { width: Math.round(a.width), status: !!island.querySelector('[data-voice-strip]'), micAtRight: Math.abs(a.right - mic.right) < 1, overlaps: others.filter(el => box(el).width && hit(a, box(el))).map(el => el.tagName + '.' + el.className) };
})()`;
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
      f.bridge.voiceTranscribe = async () => (f.transcripts++ === 0 ? 'Fix the bug. Neco, send it. Then ask Necco to add tests.' : '');
      navigator.mediaDevices.getUserMedia = async () => {
        const ctx = new AudioContext(); const osc = ctx.createOscillator(); const gain = ctx.createGain(); const dest = ctx.createMediaStreamDestination();
        osc.frequency.value = 220; gain.gain.setValueAtTime(0.4, ctx.currentTime); gain.gain.setValueAtTime(0, ctx.currentTime + 1.2);
        osc.connect(gain); gain.connect(dest); osc.start();
        return dest.stream;
      };
    })()`);
    await sleep(300);
    // The first tap shows the video instead of listening; Turn on closes it, remembers it, and starts.
    await run(`document.querySelector('[aria-label="Start listening"]').click()`);
    for (let i = 0; i < 30 && !(await run(`!!document.querySelector('[data-voice-intro]')`)); i++) await sleep(200);
    report.checks.introShownFirst = await run(`!!document.querySelector('[data-voice-intro]') && !document.querySelector('[aria-label="Stop listening"]')`);
    await sleep(2500);
    await shot('intro-dark');
    await run(`document.documentElement.dataset.theme = 'light'`); await sleep(300);
    await shot('intro-light');
    // The second scene: words arriving above the island, never under it.
    await sleep(7000);
    await shot('intro-talk-light');
    await run(`document.documentElement.dataset.theme = 'dark'`);
    await run(`Array.from(document.querySelectorAll('[role=dialog] button')).find(b => b.textContent === 'Turn on').click()`);
    await sleep(700);
    report.checks.introSeen = await run('layoutFixture.store.getState().settings.voice.introSeen === true && !document.querySelector("[data-voice-intro]")');
    report.checks.listening = await run(`document.querySelector('[aria-label="Stop listening"]')?.getAttribute('aria-pressed')`);
    await shot('listening-dark');
    report.checks.islandWide = await run(islandLayout);
    // The island must not cover the editor or any control in the bar, however narrow the composer gets.
    for (const width of [640, 480]) {
      win.setContentSize(width, 700); await sleep(500);
      report.checks[`island${width}`] = await run(islandLayout);
      await shot(`listening-${width}`);
    }
    win.setContentSize(900, 700); await sleep(500);
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
    // The island opening, at real speed: stop, tap again, grab what the compositor shows.
    await run(`document.querySelector('[aria-label="Stop listening"]').click()`);
    await sleep(600);
    await run(`document.querySelector('[aria-label="Start listening"]').click()`);
    for (let i = 0; i < 40 && !(await run(`!!document.querySelector('[data-voice-strip]')`)); i++) await sleep(5);
    for (let i = 0; i < 8; i++) await shot(`open-${i}`);
  } catch (e) { report.errors.push(String(e && e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.captures.length ? 0 : 1);
});
