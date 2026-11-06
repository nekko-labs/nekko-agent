// Isolated full-App renderer verification of the toolbar hover motion (plus
// menu fade, layout pill preview), General's first card and settings in the
// command palette. Run through layout-evidence-integration.cjs.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
// Against another revision (the "before"), take the shots but skip the checks.
const before = !!process.env.NEKKO_TEST_SOURCE;
app.setPath('userData', path.join(out, 'profile'));
app.setPath('sessionData', path.join(out, 'profile'));
const js = value => JSON.stringify(value).replace(/[<>/\u2028\u2029]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_wc, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1400, height: 900, show: false, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const errors = [];
  win.webContents.on('console-message', e => { if (e.level === 'error') errors.push(e.message); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const checks = [];
  const check = async (name, expression) => { if (before) return; if (!await run(expression)) throw Error(name); checks.push(name); };
  const grab = async () => (await win.capturePage(undefined, { stayHidden: true })).toPNG();
  const shot = async name => {
    await run(`document.getAnimations().forEach(a=>{if(a.effect?.getComputedTiming().endTime<2000) a.finish()})`);
    await run(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
    win.webContents.invalidate(); await sleep(200);
    fs.writeFileSync(path.join(out, name + '.png'), await grab());
  };
  const center = selector => run(`(()=>{const r=document.querySelector(${js(selector)}).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  const move = p => win.webContents.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y });
  // Hidden windows do not tick animations, so step the running ones by hand:
  // each frame seeks every animation to the same time on its real curve.
  let frameNo = 0;
  const scrub = async (dir, ms, step = 20) => {
    fs.mkdirSync(path.join(out, dir), { recursive: true });
    for (let t = 0; t <= ms; t += step) {
      await run(`document.getAnimations().forEach(a=>{try{a.pause();a.currentTime=${t}}catch{}})`);
      await run(`new Promise(r=>requestAnimationFrame(()=>r()))`); win.webContents.invalidate(); await sleep(30);
      fs.writeFileSync(path.join(out, dir, `frame-${String(frameNo++).padStart(3, '0')}.png`), await grab());
    }
    await run(`document.getAnimations().forEach(a=>{try{a.finish()}catch{}})`);
  };
  const type = text => run(`(()=>{const i=document.querySelector('input[aria-label^="Type a command"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,${js(text)});i.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  const away = { x: 700, y: 820 };
  try {
    await win.loadFile(path.join(out, 'index.html')); await sleep(1600);
    await run(`layoutFixture.store.setState({view:'command'})`); await sleep(400);
    // The one-time zones intro would cover the toolbar.
    await run(`[...document.querySelectorAll('[role="dialog"] button')].find(b=>/close/i.test(b.getAttribute('aria-label')||''))?.click()`); await sleep(400);
    await shot('toolbar');

    // Plus: hover opens the menu with a fast fade.
    const plus = await center('[data-wall-create-toggle]');
    frameNo = 0; move(plus); await sleep(150); await scrub('plus-motion', 160);
    await shot('plus-menu');
    await check('plus menu fades in', `getComputedStyle(document.querySelector('[data-wall-create-menu]')).animationName==='create-menu-in'`);
    move(away); await sleep(400);

    // Layout: the pill follows the pointer to Dynamic without committing.
    const focusBtn = '.wall-layout-segments button:first-of-type', dynamicBtn = '.wall-layout-segments button:last-of-type';
    await run(`document.querySelector(${js(focusBtn)}).click()`); await sleep(400);
    const dynamic = await center(dynamicBtn), focused = await center(focusBtn);
    frameNo = 0;
    for (const p of [dynamic, focused, dynamic, away]) { move(p); await sleep(120); await scrub('layout-motion', 240); }
    move(dynamic); await sleep(400); await shot('layout-hover-dynamic');
    await check('hover moves the pill onto Dynamic', `(()=>{const p=document.querySelector('.wall-layout-pill'),b=document.querySelector(${js(dynamicBtn)});return new DOMMatrix(getComputedStyle(p).transform).m41===b.offsetLeft&&p.offsetWidth===b.offsetWidth})()`);
    await check('hover does not commit the mode', `document.querySelector(${js(focusBtn)}).getAttribute('aria-pressed')==='true'&&document.querySelector(${js(dynamicBtn)}).getAttribute('aria-pressed')==='false'`);
    move(away); await sleep(400);
    await check('leaving returns the pill to Focused', `new DOMMatrix(getComputedStyle(document.querySelector('.wall-layout-pill')).transform).m41===document.querySelector(${js(focusBtn)}).offsetLeft`);

    // Settings > General starts with Help improve Nekko Agent.
    await run(`layoutFixture.store.setState({view:'settings'})`); await sleep(800);
    await shot('settings-general');
    await check('Help improve is first in General', `document.querySelector('[data-settings-group="general"] section')?.id==='usage-reports'`);

    // Command palette lists matching settings with their controls.
    await run(`layoutFixture.store.setState({view:'command'}); layoutFixture.store.getState().setPaletteOpen(true)`); await sleep(400);
    await type('notif'); await sleep(300); await shot('palette-notif');
    await check('palette shows the setting with its switch', `!!document.querySelector('[data-palette-setting="desktop-notifications"] [role="switch"]')`);
    const before0 = await run(`layoutFixture.store.getState().settings?.desktopNotifications`);
    await run(`document.querySelector('[data-palette-setting="desktop-notifications"] [role="switch"]')?.click()`); await sleep(300);
    await check('switch flips the saved setting in place', `layoutFixture.store.getState().settings.desktopNotifications===${before0 === false ? 'true' : 'false'}&&!!document.querySelector('[data-palette-setting]')`);
    await type('git'); await sleep(300); await shot('palette-git');
    await check('palette shows choices as selects', `document.querySelectorAll('[data-palette-setting] select').length>=2`);
    await type('guardrail'); await sleep(300); await shot('palette-guardrail');
    await check('palette offers the Settings group for a section', `[...document.querySelectorAll('[role="option"]')].some(o=>o.textContent.includes('Settings: Safety'))`);

    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ checks, errors, hidden: !win.isVisible(), bounds: win.getBounds() }, null, 2));
  } catch (e) { console.error(e); process.exitCode = 1; }
  finally { win.destroy(); app.quit(); }
});
