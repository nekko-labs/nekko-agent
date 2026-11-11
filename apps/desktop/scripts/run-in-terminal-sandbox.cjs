// Run a suggested command in the chat's terminal (#2595), in a hidden,
// off-screen, non-focusable window against run-in-terminal-fixture.tsx.
// NEKKO_RUN_BASELINE=1 captures an unchanged renderer without asserting.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs with NEKKO_LAYOUT_FIXTURE=run-in-terminal-fixture.tsx');
const baseline = process.env.NEKKO_RUN_BASELINE === '1';
const modules = process.env.NEKKO_TEST_MODULES || path.resolve(__dirname, '../../../node_modules');
// A fresh profile each run: a draft saved by the last run would show in the composer.
fs.rmSync(path.join(out, 'profile'), { recursive: true, force: true });
app.setPath('userData', path.join(out, 'profile'));
app.setPath('sessionData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const js = (v) => JSON.stringify(v).replace(/[<>/\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

/** Frames to a GIF with a palette drawn from the frames' own most common colours. */
function writeGif(file, frames, delayCs) {
  const { PNG } = require(path.join(modules, 'pngjs'));
  const { GifWriter } = require(path.join(modules, 'omggif'));
  const pngs = frames.map(b => PNG.sync.read(b));
  const { width, height } = pngs[0];
  const counts = new Map();
  for (const p of pngs) for (let i = 0; i < p.data.length; i += 16) {
    const key = ((p.data[i] >> 3) << 10) | ((p.data[i + 1] >> 3) << 5) | (p.data[i + 2] >> 3);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const palette = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 256).map(([k]) => (((k >> 10) & 31) << 19) | (((k >> 5) & 31) << 11) | ((k & 31) << 3));
  while (palette.length < 256) palette.push(0);
  const rgb = palette.map(c => [(c >> 16) & 255, (c >> 8) & 255, c & 255]);
  const cache = new Map();
  const nearest = (r, g, b) => {
    const key = (r << 16) | (g << 8) | b;
    if (cache.has(key)) return cache.get(key);
    let best = 0, dist = Infinity;
    for (let i = 0; i < rgb.length; i++) { const d = (rgb[i][0] - r) ** 2 + (rgb[i][1] - g) ** 2 + (rgb[i][2] - b) ** 2; if (d < dist) { dist = d; best = i; } }
    cache.set(key, best);
    return best;
  };
  const buf = Buffer.alloc(width * height * pngs.length * 2 + 1024 * 1024);
  const gif = new GifWriter(buf, width, height, { loop: 0, palette });
  for (const p of pngs) {
    const idx = new Uint8Array(width * height);
    for (let i = 0; i < idx.length; i++) idx[i] = nearest(p.data[i * 4], p.data[i * 4 + 1], p.data[i * 4 + 2]);
    gif.addFrame(0, 0, width, height, idx, { delay: delayCs });
  }
  fs.writeFileSync(file, buf.subarray(0, gif.end()));
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1100, height: 760, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -5000, y: -5000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false, offscreen: true } });
  const report = { baseline, errors: [], console: [], captures: [], checks: {} };
  win.on('show', () => report.errors.push('Window became visible'));
  win.on('focus', () => report.errors.push('Window took focus'));
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) report.console.push(message); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const shot = async (name, rect) => {
    await win.capturePage(undefined, { stayHidden: true });
    await sleep(120);
    const file = path.join(out, `${name}.png`);
    fs.writeFileSync(file, (await win.capturePage(rect, { stayHidden: true })).toPNG());
    report.captures.push(file);
  };
  const check = (name, ok, detail) => { report.checks[name] = { ok: Boolean(ok), detail }; if (!ok && !baseline) report.errors.push(`${name} failed: ${js(detail)}`); };
  // A hidden window counts as an inactive app, which pauses every animation
  // (html[data-app-inactive]); keep it active so the terminal's entrance is real.
  const keepActive = () => run(`(() => { const h = document.documentElement; const off = () => h.removeAttribute('data-app-inactive'); off(); new MutationObserver(off).observe(h, { attributes: true, attributeFilter: ['data-app-inactive'] }); })()`);
  const rectOf =sel => run(`(() => { const r = fx().querySelector(${js(sel)})?.getBoundingClientRect(); return r && { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; })()`);
  const hover = async sel => {
    const r = await rectOf(sel);
    if (r) win.webContents.sendInputEvent({ type: 'mouseMove', x: r.x + r.width - 30, y: r.y + 12 });
    await sleep(250);
  };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    await sleep(1500);
    await run('window.runFixture.show()');
    await keepActive();
    await sleep(1500);
    // One width per launch (NEKKO_RUN_WIDTH, default 1100): Share output leaves
    // a saved draft behind, so a second width in the same window would show it.
    for (const width of [Number(process.env.NEKKO_RUN_WIDTH) || 1100]) {
      win.setContentSize(width, 760);
      await sleep(400);
      await shot(`run-${width}-idle`);
      await hover('pre');
      await shot(`run-${width}-hover`);
      check(`run-button-${width}`, await run("fx().querySelectorAll('[data-run-command]').length === 2"), await run("[...fx().querySelectorAll('[data-code-block]')].map(b => b.querySelector('[data-run-command]') ? 'run' : 'none')"));
      if (baseline) continue;
      const frames = [];
      const showBlock = (n) => run(`fx().querySelectorAll('[data-code-block]')[${n}].scrollIntoView({ block: 'start' })`);
      // The recording keeps the transcript as the user left it (at the latest
      // reply): the transcript, above the composer, as Run opens the terminal.
      const crop = { x: 0, y: 44, width, height: 540 };
      for (let i = 0; i < 4; i++) { frames.push((await win.capturePage(crop, { stayHidden: true })).toPNG()); await sleep(60); }
      await run("fx().querySelector('[data-run-command]').click()");
      for (let i = 0; i < 12; i++) { frames.push((await win.capturePage(crop, { stayHidden: true })).toPNG()); await sleep(30); }
      for (let i = 0; i < 8; i++) { frames.push((await win.capturePage(crop, { stayHidden: true })).toPNG()); await sleep(150); }
      if (width === 1100) writeGif(path.join(out, 'run-1100-open.gif'), frames, 8);
      // The block that ran stays in sight while the transcript follows the latest reply.
      const ranBlock = await rectOf('[data-code-block]');
      check(`block-in-view-${width}`, ranBlock && ranBlock.y >= 40 && ranBlock.y + ranBlock.height <= 600, ranBlock);
      await showBlock(0);
      await sleep(200);
      await shot(`run-${width}-open`);
      const state = await run("({ runs: window.runFixture.runs, created: window.runFixture.created, inline: fx().querySelectorAll('[data-inline-terminal]').length, xterm: !!fx().querySelector('[data-inline-terminal] .xterm'), header: fx().querySelector('[data-inline-terminal] [data-inline-terminal-title]')?.textContent, opacity: getComputedStyle(fx().querySelector('[data-inline-terminal]')).opacity, animations: fx().querySelector('[data-inline-terminal]').getAnimations().map(a => a.playState + ':' + a.currentTime), rows: fx().querySelector('[data-inline-terminal] .xterm-rows')?.innerText.slice(0, 200) ?? null, size: fx().querySelector('[data-inline-terminal] .xterm-screen')?.getBoundingClientRect().height })");
      check(`runs-first-block-${width}`, state.runs.at(-1)?.command === 'npm ci\rnpm run build', state);
      check(`inline-terminal-${width}`, state.inline === 1 && state.xterm, state);
      check(`one-terminal-for-the-chat-${width}`, state.created.length === 1 && state.created[0].sessionId === 'a' && state.created[0].cwd === '/Users/me/code/app', state.created);
      // The second block reuses the chat's terminal and runs only its prompt line.
      await run("fx().querySelectorAll('[data-run-command]')[1].click()");
      await sleep(900);
      const second = await run("({ runs: window.runFixture.runs, created: window.runFixture.created.length, inline: fx().querySelectorAll('[data-inline-terminal]').length })");
      check(`second-block-reuses-${width}`, second.created === 1 && second.runs.at(-1)?.command === 'npm test' && second.runs.at(-1)?.id === second.runs.at(-2)?.id, second);
      await showBlock(1);
      await sleep(200);
      await shot(`run-${width}-second`);
      // One view of the chat's terminal at a time: it moved under the second block.
      check(`terminal-moved-${width}`, await run("fx().querySelectorAll('[data-code-block]')[1].querySelector('[data-inline-terminal]') !== null"), null);
      await run("fx().querySelector('[data-share-output]')?.click()");
      await sleep(500);
      const draft = await run("fx().querySelector('[contenteditable]')?.innerText ?? ''");
      check(`share-output-${width}`, draft.startsWith('Output from my terminal:') && draft.includes('42 tests passed') && !draft.includes('\x1b'), draft.slice(0, 400));
      await shot(`run-${width}-shared`);
      await run("[...fx().querySelectorAll('[data-hide-terminal]')].forEach(b => b.click())");
      await sleep(400);
      check(`hide-${width}`, (await run("fx().querySelectorAll('[data-inline-terminal]').length")) === 0, null);
    }
    if (win.isVisible() || win.isFocused()) report.errors.push('Window was visible or focused');
    report.success = report.errors.length === 0;
  } catch (e) { report.errors.push(String(e.stack || e)); report.success = false; }
  finally {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ success: report.success, errors: report.errors, checks: report.checks, console: report.console.slice(0, 20) }, null, 2));
    win.destroy();
    app.exit(report.success || baseline ? 0 : 1);
  }
});
