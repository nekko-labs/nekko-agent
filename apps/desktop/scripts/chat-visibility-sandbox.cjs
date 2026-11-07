// #1666: the conversation scrolls behind the floating plan and the cat, and
// Simple keeps Detailed's purpose summary and caret for a turn's steps while
// leaving out the reasoning rows. Run through layout-evidence-integration.cjs
// (NEKKO_LAYOUT_SANDBOX=chat-visibility-sandbox.cjs); NEKKO_TEST_SOURCE can
// point at an unchanged base tree for the "before" captures.
// Hidden, off-screen, non-focusable window, isolated profile, network blocked.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const js = v => JSON.stringify(v).replace(/[<>/\u2028\u2029]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const report = { metrics: {}, checks: [], errors: [], captures: [] };
const check = (name, pass, detail) => report.checks.push({ name, pass: !!pass, ...(detail === undefined ? {} : { detail }) });
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1100, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -10000, y: -10000, title: 'Chat visibility, isolated evidence', webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('show', () => report.errors.push('Window became visible'));
  win.on('focus', () => report.errors.push('Window took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  const run = code => win.webContents.executeJavaScript(code, true);
  const shot = async name => {
    // A hidden window repaints only when asked: settle a couple of frames first.
    for (let i = 0; i < 2; i++) { win.webContents.invalidate(); await sleep(600); await win.capturePage(undefined, { stayHidden: true }); }
    const file = path.join(out, name + '.png');
    fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG());
    report.captures.push(file);
  };
  const scroll = async to => { await run(`(() => { const s = document.querySelector('[data-transcript-scroll]'); s.scrollTop = ${to === 'bottom' ? 's.scrollHeight' : to}; })()`); await sleep(500); };
  const scene = async mode => {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 80 && !await run('!!window.layoutFixture').catch(() => false); i++) await sleep(100);
    await run(`localStorage.setItem('fixture.platform','win32'); localStorage.setItem('nekko.chatMode', ${js(mode)})`);
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 80 && !await run('!!window.layoutFixture').catch(() => false); i++) await sleep(100);
    await run('layoutFixture.showVisibility()');
    for (let i = 0; i < 50 && !await run(`!!document.querySelector('.plan-sheet-dock') && !!document.querySelector('[data-transcript-scroll]')`).catch(() => false); i++) await sleep(100);
    await sleep(1200);
  };
  const rect = s => `(() => { const e = document.querySelector(${js(s)}); if (!e) return null; const b = e.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), height: Math.round(b.height) }; })()`;
  const caret = `[...document.querySelectorAll('[data-transcript-scroll] button[aria-expanded]')].find(b => /^[▸▾]/.test(b.textContent.trim()))`;
  try {
    await scene('simple');
    // Where the plan, the scroll area and the composer sit.
    const layout = await run(`({ plan: ${rect('.plan-sheet-dock')}, scroll: ${rect('[data-transcript-scroll]')}, composer: ${rect('.composer-section .composer')}, padding: getComputedStyle(document.querySelector('[data-transcript-scroll]')).paddingBottom })`);
    report.metrics.layout = layout;
    check('the transcript scroll area reaches behind the plan', layout.plan && layout.scroll && layout.scroll.bottom > layout.plan.top + 20, layout);
    check('the transcript padding clears the plan', layout.plan && parseFloat(layout.padding) >= layout.plan.height, layout.padding);
    // A few rows short of the end: those rows are behind the plan (after) or below the pane (before).
    await scroll('s.scrollHeight - s.clientHeight - 240');
    await shot('plan-mid-scroll');
    await scroll('bottom');
    await shot('plan-bottom');
    // Scrolled to the end, the last line of the answer sits above the plan.
    const tail = await run(`(() => { const ps = [...document.querySelectorAll('[data-transcript-scroll] p')]; const last = ps[ps.length - 1]; const plan = document.querySelector('.plan-sheet-dock'); return last && plan ? { lastBottom: Math.round(last.getBoundingClientRect().bottom), planTop: Math.round(plan.getBoundingClientRect().top) } : null; })()`);
    report.metrics.tail = tail;
    check('scrolled to the end, the last row is clear of the plan', tail && tail.lastBottom <= tail.planTop, tail);
    // A short recording: the last rows of the answer scrolling up from behind the plan.
    const frames = [];
    for (let i = 0; i <= 12; i++) {
      await run(`(() => { const s = document.querySelector('[data-transcript-scroll]'); s.scrollTop = s.scrollHeight - s.clientHeight - ${(12 - i) * 40}; })()`);
      win.webContents.invalidate(); await sleep(200); await win.capturePage(undefined, { stayHidden: true });
      win.webContents.invalidate(); await sleep(150);
      frames.push((await win.capturePage(undefined, { stayHidden: true })).resize({ width: 700 }).toPNG());
    }
    const modules = process.env.NEKKO_TEST_MODULES || path.resolve(__dirname, '../../../node_modules');
    const { PNG } = require(path.join(modules, 'pngjs'));
    const { GifWriter } = require(path.join(modules, 'omggif'));
    const images = frames.map(f => PNG.sync.read(f));
    const counts = new Map();
    for (const image of images) for (let i = 0; i < image.data.length; i += 4) { const rgb = (image.data[i] << 16) | (image.data[i + 1] << 8) | image.data[i + 2]; counts.set(rgb, (counts.get(rgb) || 0) + 1); }
    const palette = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 256).map(([rgb]) => rgb);
    while (palette.length < 256) palette.push(0);
    const nearest = new Map();
    const data = Buffer.alloc(images[0].width * images[0].height * images.length * 2);
    const gif = new GifWriter(data, images[0].width, images[0].height, { loop: 0, palette });
    images.forEach((image, n) => {
      const indices = new Uint8Array(image.width * image.height);
      for (let i = 0; i < indices.length; i++) {
        const r = image.data[i * 4], g = image.data[i * 4 + 1], b = image.data[i * 4 + 2], rgb = (r << 16) | (g << 8) | b;
        if (!nearest.has(rgb)) { let best = 0, distance = Infinity; palette.forEach((p, k) => { const d = (r - (p >> 16)) ** 2 + (g - ((p >> 8) & 255)) ** 2 + (b - (p & 255)) ** 2; if (d < distance) { best = k; distance = d; } }); nearest.set(rgb, best); }
        indices[i] = nearest.get(rgb);
      }
      gif.addFrame(0, 0, image.width, image.height, indices, { delay: n === images.length - 1 ? 120 : 12 });
    });
    fs.writeFileSync(path.join(out, 'scroll-behind-plan.gif'), data.subarray(0, gif.end()));
    report.captures.push(path.join(out, 'scroll-behind-plan.gif'));
    await scroll(0);
    // The virtual transcript mounts the top rows again after the jump.
    for (let i = 0; i < 30 && !await run(`!!(${caret}) || !!document.querySelector('[data-simple-steps]')`); i++) await sleep(100);
    const simple = await run(`(() => { const s = document.querySelector('[data-transcript-scroll]'); const c = ${caret}; return { folded: !!document.querySelector('[data-simple-steps]'), caret: c ? c.textContent.trim().slice(0, 60) : null, reasoning: s.innerText.includes('Check the project guidance before editing.') }; })()`);
    report.metrics.simple = simple;
    check('Simple: no one-line step fold', !simple.folded, simple);
    check('Simple: the purpose summary with a caret', !!simple.caret, simple.caret);
    check('Simple: no reasoning row', !simple.reasoning);
    await shot('simple-summary');
    await run(`${caret}?.click()`); await sleep(500);
    report.metrics.simpleOpen = await run(`(() => { const s = document.querySelector('[data-transcript-scroll]'); return { expanded: ${caret}?.getAttribute('aria-expanded') ?? null, reasoning: s.innerText.includes('Check the project guidance before editing.') }; })()`);
    check('Simple: the caret opens the steps, still without reasoning', report.metrics.simpleOpen.expanded === 'true' && !report.metrics.simpleOpen.reasoning, report.metrics.simpleOpen);
    await shot('simple-summary-open');
    await scene('expert');
    await scroll(0);
    for (let i = 0; i < 30 && !await run(`!!(${caret})`); i++) await sleep(100);
    report.metrics.expert = await run(`(() => { const s = document.querySelector('[data-transcript-scroll]'); const c = ${caret}; return { caret: c ? c.textContent.trim().slice(0, 60) : null, reasoning: s.innerText.includes('Check the project guidance') || !!s.querySelector('[data-reasoning], details') }; })()`);
    await shot('detailed-summary');
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.errors.length ? 1 : 0);
});
