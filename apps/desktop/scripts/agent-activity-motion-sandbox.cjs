// Agents panel evidence for activity grouping: the default view and the
// Activity view with an agent in each phase of the loop, then frames of one
// moving from Verifying to Shipping, encoded as a GIF. Hidden,
// off-screen, non-focusable. Launch through layout-evidence-integration.cjs with
// NEKKO_LAYOUT_SANDBOX=agent-activity-motion-sandbox.cjs.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { GifWriter } = require('omggif');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], errors: [] };

/** Encode RGBA frames as a GIF, with a palette of the frames' most common colors. */
function writeGif(file, frames, width, height, delayCs) {
  const q = (r, g, b) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
  const counts = new Map();
  for (const f of frames) for (let i = 0; i < f.length; i += 16) { const k = q(f[i], f[i + 1], f[i + 2]); counts.set(k, (counts.get(k) || 0) + 1); }
  const palette = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 256).map(([k]) => k);
  while (palette.length < 256) palette.push(0);
  const rgb = palette.map(k => (((k >> 10) & 31) << 19) | (((k >> 5) & 31) << 11) | ((k & 31) << 3));
  const nearest = new Map();
  const pick = k => {
    if (nearest.has(k)) return nearest.get(k);
    const r = (k >> 10) & 31, g = (k >> 5) & 31, b = k & 31;
    let best = 0, bestD = Infinity;
    palette.forEach((p, i) => { const d = (((p >> 10) & 31) - r) ** 2 + (((p >> 5) & 31) - g) ** 2 + ((p & 31) - b) ** 2; if (d < bestD) { bestD = d; best = i; } });
    nearest.set(k, best);
    return best;
  };
  const buf = Buffer.alloc(width * height * frames.length * 2 + 1024 * 1024);
  const gif = new GifWriter(buf, width, height, { palette: rgb, loop: 0 });
  for (const f of frames) {
    const idx = new Uint8Array(width * height);
    for (let p = 0; p < idx.length; p++) idx[p] = pick(q(f[p * 4], f[p * 4 + 1], f[p * 4 + 2]));
    gif.addFrame(0, 0, width, height, idx, { delay: delayCs });
  }
  fs.writeFileSync(file, buf.subarray(0, gif.end()));
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const minX = Math.min(...screen.getAllDisplays().map(d => d.bounds.x)), minY = Math.min(...screen.getAllDisplays().map(d => d.bounds.y));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: minX - 1700, y: minY - 1100, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => { report.errors.push('took focus'); });
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const crop = { x: 0, y: 0, width: 320, height: 900 };
  const grab = async () => (await win.capturePage(crop, { stayHidden: true, stayAwake: false }));
  const shot = async name => { const f = path.join(out, name + '.png'); fs.writeFileSync(f, (await grab()).toPNG()); report.captures.push(f); };
  const ready = async () => { for (let i = 0; i < 50 && !(await run("!!document.querySelector('[title=\"View options: group, sort and show\"]')")); i++) await sleep(200); await sleep(900); };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    await ready();
    // b waits on a question, c and a are working, d is done; each is at a phase.
    const phases = { a: { phase: 'building', exchangeCount: 2 }, b: { phase: 'exploring', exchangeCount: 2 }, c: { phase: 'verifying', exchangeCount: 2 }, d: { phase: 'shipping', exchangeCount: 2 } };
    await run(`localStorage.setItem('fixture.summaries', ${JSON.stringify(JSON.stringify(phases))}); localStorage.removeItem('nekko.agentPanelView'); localStorage.setItem('fixture.pending', JSON.stringify({ b: {} })); localStorage.setItem('fixture.running', JSON.stringify(['a', 'c'])); location.reload()`).catch(() => {});
    await sleep(500); await ready(); await sleep(1200);
    await shot('default-view');
    report.defaultGroups = await run("Array.from(document.querySelectorAll('[data-agent-group]')).map(e => e.getAttribute('data-agent-group'))");
    await run(`localStorage.setItem('nekko.agentPanelView', JSON.stringify({ groupBy: 'status' })); location.reload()`).catch(() => {});
    await sleep(500); await ready(); await sleep(1200);
    await shot('activity-view');
    report.activityGroups = await run("Array.from(document.querySelectorAll('[data-agent-group]')).map(e => e.getAttribute('data-agent-group') + ':' + e.querySelectorAll('[role=button][title]').length)");
    // c commits: the engine tells every window, and the card should leave Verifying for Shipping.
    const frames = [];
    const t0 = Date.now();
    phases.c.phase = 'shipping';
    await run(`localStorage.setItem('fixture.summaries', ${JSON.stringify(JSON.stringify(phases))}); layoutFixture.emitAgent({ type: 'session_meta', sessionId: 'c' })`);
    while (Date.now() - t0 < 1500) { const img = await grab(); frames.push(img.toBitmap()); report.frameSize = img.getSize(); if (frames.length % 4 === 0 && frames.length <= 16) fs.writeFileSync(path.join(out, `move-frame-${frames.length}.png`), img.toPNG()); await sleep(15); }
    report.frames = frames.length;
    report.frameMs = Math.round((Date.now() - t0) / frames.length);
    await shot('activity-after-move');
    report.afterMoveGroups = await run("Array.from(document.querySelectorAll('[data-agent-group]')).map(e => e.getAttribute('data-agent-group') + ':' + e.querySelectorAll('[role=button][title]').length)");
    // A new chat nothing was sent in brings the Draft group with it.
    const draft = { ...phases, d: { exchangeCount: 0 } };
    await run(`localStorage.setItem('fixture.summaries', ${JSON.stringify(JSON.stringify(draft))}); layoutFixture.emitAgent({ type: 'session_meta', sessionId: 'd' })`);
    await sleep(1400);
    await shot('activity-with-draft');
    report.draftGroups = await run("Array.from(document.querySelectorAll('[data-agent-group]')).map(e => e.getAttribute('data-agent-group') + ':' + e.querySelectorAll('[role=button][title]').length)");
    // Answering b sends it back to its phase, and the empty Needs input group goes with it.
    await run(`layoutFixture.emitAgent({ type: 'question_resolved', sessionId: 'b' })`);
    await sleep(1400);
    await shot('activity-after-answer');
    report.afterAnswerGroups = await run("Array.from(document.querySelectorAll('[data-agent-group]')).map(e => e.getAttribute('data-agent-group') + ':' + e.querySelectorAll('[role=button][title]').length)");
    // A sub-agent has no card, so its question lifts its parent, a, to Needs input.
    const child = { ...draft, d: { exchangeCount: 1, parentSessionId: 'a' } };
    await run(`localStorage.setItem('fixture.summaries', ${JSON.stringify(JSON.stringify(child))}); layoutFixture.emitAgent({ type: 'session_meta', sessionId: 'd' })`);
    await sleep(400);
    await run(`layoutFixture.emitAgent({ type: 'question', sessionId: 'd' })`);
    await sleep(1400);
    await shot('activity-sub-agent-waiting');
    report.subAgentGroups = await run("Array.from(document.querySelectorAll('[data-agent-group]')).map(e => e.getAttribute('data-agent-group') + ':' + Array.from(e.querySelectorAll('[role=button][title]')).map(c => c.title).join('|'))");
    // toBitmap is BGRA; swap to RGBA for the encoder.
    for (const f of frames) for (let i = 0; i < f.length; i += 4) { const b = f[i]; f[i] = f[i + 2]; f[i + 2] = b; }
    const { width, height } = report.frameSize;
    if (width === crop.width) writeGif(path.join(out, 'activity-move.gif'), frames, width, height, Math.max(2, Math.round(report.frameMs / 10)));
    else {
      // A HiDPI capture is 2x: downsample to the crop so the GIF stays small.
      const half = frames.map(f => { const o = Buffer.alloc(crop.width * crop.height * 4); for (let y = 0; y < crop.height; y++) for (let x = 0; x < crop.width; x++) f.copy(o, (y * crop.width + x) * 4, ((y * 2) * width + x * 2) * 4, ((y * 2) * width + x * 2) * 4 + 4); return o; });
      writeGif(path.join(out, 'activity-move.gif'), half, crop.width, crop.height, Math.max(2, Math.round(report.frameMs / 10)));
    }
    report.hidden = !win.isVisible();
  } catch (e) { report.errors.push(String(e && e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.captures.length ? 0 : 1);
});
