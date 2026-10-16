// Synthetic evidence for the Spooky hat, the eyeless Agents nav cat, the softer
// composer focus border and the dock's drag landing zone. Never connects to the
// user's host or profile. Launched through wall-polish-integration.cjs with
// NEKKO_SANDBOX=spooky-dock-drag-sandbox.cjs (add NEKKO_TEST_REVISION for "before").
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through wall-polish-integration.cjs');
const base = !!process.env.NEKKO_TEST_REVISION;
const dir = path.join(out, base ? 'before-dockdrag' : 'after-dockdrag');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(path.join(dir, 'frames'), { recursive: true });
app.setPath('userData', path.join(dir, 'profile'));
app.setPath('sessionData', path.join(dir, 'profile'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((request, done) => done({ cancel: !/^(file:|data:|blob:)/.test(request.url) }));
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, done) => done(false));
  const left = Math.min(...screen.getAllDisplays().map(d => d.bounds.x));
  const win = new BrowserWindow({
    width: 1400, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true,
    x: left - 3000, y: -2000, title: 'Synthetic polish 3 verification',
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  const report = { checks: [], errors: [], visuallyInspected: false };
  win.on('focus', () => report.errors.push('Fixture took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push('console: ' + e.message); });
  const run = source => win.webContents.executeJavaScript(source, true);
  const check = async (name, source) => {
    let ok = false;
    try { ok = !!await run(source); } catch (e) { report.errors.push(name + ': ' + e); }
    report.checks.push({ name, passed: ok });
  };
  const shot = async (file, rect) => fs.writeFileSync(path.join(dir, file), (await win.capturePage(rect, { stayHidden: true, stayAwake: false })).toPNG());
  const capture = async (name, rect) => { await sleep(350); await shot(name + '.png', rect); };
  // Only fixed, known selectors, themes and presets reach the page: the page
  // looks them up by index from tables set once, never from evaluated source.
  const SELECTORS = { gallery: '[data-mascot-gallery]', mascot: '.pixel-mascot', composer: '[data-wall-composer]', dock: '.monitors-dock' };
  const THEMES = ['dark', 'light'];
  const PRESETS = ['autumn'];
  const tables = () => run(`window.__sel=${JSON.stringify(Object.values(SELECTORS))};window.__themes=${JSON.stringify(THEMES)};window.__presets=${JSON.stringify(PRESETS)};true`);
  const rect = (key, pad) => {
    const index = Object.keys(SELECTORS).indexOf(key);
    if (index < 0 || !Number.isInteger(pad)) throw Error('unknown selector');
    return run(`(()=>{const e=document.querySelector(window.__sel[${index}]);if(!e)return undefined;const r=e.getBoundingClientRect();const p=${pad};return {x:Math.max(0,Math.floor(r.x)-p),y:Math.max(0,Math.floor(r.y)-p),width:Math.min(innerWidth,Math.ceil(r.width)+p*2),height:Math.min(innerHeight,Math.ceil(r.height)+p*2)}})()`);
  };
  const theme = (t, preset) => {
    const ti = THEMES.indexOf(t), pi = preset ? PRESETS.indexOf(preset) : -1;
    if (ti < 0 || (preset && pi < 0)) throw Error('unknown theme');
    return run(`document.documentElement.dataset.theme=window.__themes[${ti}];${pi >= 0 ? `document.documentElement.dataset.preset=window.__presets[${pi}]` : 'delete document.documentElement.dataset.preset'}`);
  };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    win.showInactive();
    // :focus-within only matches in a focused page; emulate it rather than take OS focus.
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await sleep(1000);
    await tables();

    // 1 + 2. The Spooky hat and the Agents nav cat.
    await run("integration.reset({ preset: 'autumn' })"); await sleep(600);
    await run("integration.route('mascot')"); await theme('dark', 'autumn'); await sleep(500);
    await capture('mascot-gallery-dark', await rect('gallery', 8));
    await capture('mascot-corner-dark', await rect('mascot', 24));
    await check('nav cat has no eyes', "!document.querySelector('[data-gallery=nav] .pixel-eyes-open')");

    // 3. The focused wall composer, both themes.
    for (const t of ['dark', 'light']) {
      await run('integration.reset({})'); await sleep(900); await theme(t);
      await run("document.querySelector('[data-wall-composer] [contenteditable]').focus()"); await sleep(300);
      await check(`composer is focused (${t})`, "!!document.querySelector('[data-wall-composer] .composer:focus-within')");
      await check(`one 1px border, no inset ring (${t})`, "(()=>{const c=getComputedStyle(document.querySelector('[data-wall-composer] .composer'));return parseFloat(c.borderTopWidth)<=1&&c.boxShadow==='none'})()");
      report[`composer-${t}`] = await run("(()=>{const e=document.querySelector('[data-wall-composer] .composer');const c=getComputedStyle(e);return {border:c.borderTopWidth+' '+c.borderTopColor,shadow:c.boxShadow,cls:e.className}})()");
      await capture(`composer-focus-${t}`, await rect('composer', 10));
    }

    // 4. Drag the dock's top panel down two places. Synthetic DragEvents drive
    // React's handlers; the OS drag image does not exist for synthetic drags,
    // so a fixture-only ghost (a clone) follows the pointer for the recording.
    await run("integration.reset({ dockAll: true })"); await sleep(1200); await theme('dark');
    const dockRect = await rect('dock', 0);
    await capture('dock-rest-dark', dockRect);
    await run(`window.__dt = new DataTransfer();
      window.__fire = (type, el, x, y) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: window.__dt, clientX: x, clientY: y }));
      window.__head = document.querySelector('[data-monitor="vitals"] > header') || document.querySelectorAll('.monitors-dock__monitor-header')[0];
      window.__panels = document.querySelector('.monitors-dock__monitors');
      const r = window.__head.closest('section').getBoundingClientRect();
      window.__grab = { x: 60, y: 18, r };
      const g = window.__head.closest('section').cloneNode(true);
      g.id = 'fixture-ghost';
      Object.assign(g.style, { position: 'fixed', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', margin: 0, zIndex: 999, opacity: .85, pointerEvents: 'none', boxShadow: '0 16px 32px -12px rgb(0 0 0 / .6)', display: 'block' });
      g.removeAttribute('data-monitor-lifted'); g.removeAttribute('data-monitor');
      window.__ghost = g;
      true`);
    let frame = 0;
    const record = async (n, gap = 16) => { for (let i = 0; i < n; i++) { await shot(path.join('frames', String(frame++).padStart(4, '0') + '.png'), dockRect); await sleep(gap); } };
    await record(8);
    const start = await run("({ x: __grab.r.left + __grab.x, y: __grab.r.top + __grab.y })");
    await run(`__fire('dragstart', __head, ${start.x}, ${start.y}); document.body.append(__ghost); true`);
    await record(6);
    await check('lifting opens a zone in the panel\'s own place', base ? 'true' : "document.querySelectorAll('.monitors-dock__landing[data-open]').length===1 && !!document.querySelector('[data-monitor-lifted]')");
    await capture(base ? 'dock-dragging-dark' : 'dock-lifted-dark', dockRect);
    // Walk the pointer down over the next two panels.
    const target = await run("(()=>{const s=[...document.querySelectorAll('.monitors-dock__monitor:not([data-monitor-lifted])')];const r=s[1].getBoundingClientRect();return {x:r.left+60,y:r.top+r.height*0.7}})()");
    const steps = 24;
    for (let i = 1; i <= steps; i++) {
      const x = start.x + (target.x - start.x) * i / steps;
      const y = start.y + (target.y - start.y) * i / steps;
      await run(`__ghost.style.left=(${x}-__grab.x)+'px';__ghost.style.top=(${y}-__grab.y)+'px';__fire('dragover', document.elementFromPoint(${x}, ${y}) || __panels, ${x}, ${y}); true`);
      await record(1, 8);
    }
    await record(14);
    await check('the zone moved under the pointer', base ? 'true' : "(()=>{const z=document.querySelector('.monitors-dock__landing[data-open]');const s=[...document.querySelector('.monitors-dock__monitors').children];return !!z && s.indexOf(z) > 2})()");
    await capture(base ? 'dock-over-dark' : 'dock-zone-open-dark', dockRect);
    await run(`__ghost.remove(); __fire('drop', document.elementFromPoint(${target.x}, ${target.y}) || __panels, ${target.x}, ${target.y}); __fire('dragend', __head, ${target.x}, ${target.y}); true`);
    await record(22, 8);
    await check('vitals landed third', "(()=>{const s=[...document.querySelectorAll('.monitors-dock__monitor')].map(e=>e.getAttribute('aria-label'));return s[2]==='Vitals monitor'})()");
    await check('no zones after drop', "!document.querySelector('.monitors-dock__landing')");
    await capture('dock-dropped-dark', dockRect);
    if (win.isFocused()) throw Error('Fixture focus invariant failed');
    report.background = { visible: win.isVisible(), focused: win.isFocused(), bounds: win.getBounds() };
    report.frames = frame;
    report.success = !report.errors.some(e => /focus/.test(e)) && (base || report.checks.every(c => c.passed));
  } catch (error) {
    report.errors.push(String(error)); report.success = false;
  } finally {
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ dir, success: report.success, checks: report.checks, errors: report.errors.slice(0, 8) }, null, 2));
    win.destroy(); app.exit(report.success ? 0 : 1);
  }
});
