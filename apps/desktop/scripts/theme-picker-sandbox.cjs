// Real Settings/ThemeStep components; hidden Electron, disposable profile, no network.
// Run through layout-evidence-integration.cjs. Set NEKKO_THEME_BASELINE=1 for base.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const minX = Math.min(...screen.getAllDisplays().map(d => d.bounds.x));
  const win = new BrowserWindow({ width: 1440, height: 1000, show: false, focusable: false, skipTaskbar: true, x: minX - 1600, y: -1200, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const report = { errors: [], captures: [], checks: {} };
  win.on('focus', () => report.errors.push('took focus'));
  const run = s => win.webContents.executeJavaScript(s, true);
  const check = (key, passed) => { report.checks[key] = passed; if (!passed) throw Error(key); };
  const shot = async name => { fs.writeFileSync(path.join(out, `${name}.png`), (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(name); };
  const click = async selector => { await run(`document.querySelector(${JSON.stringify(selector)}).click()`); await sleep(150); };
  const scroll = async () => { await run(`document.querySelector('[data-nekko-mode], .theme-mode-toggle').closest('section').scrollIntoView({block:'start'})`); await sleep(300); };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 100 && !(await run('!!window.layoutFixture')); i++) await sleep(100);
    await run(`layoutFixture.store.getState().setView('settings')`);
    await sleep(1200);
    await run(`(() => {const s=layoutFixture.store; const settings={...s.getState().settings,theme:'dark',themePreset:'x-plum-dark',accent:'#c084b5',accent2:'#c99bb3'};layoutFixture.bridge.updateSettings(settings);s.setState({settings});s.getState().applyTheme();})()`);
    await scroll(); await shot('appearance-desktop');
    if (!process.env.NEKKO_THEME_BASELINE) {
      check('compact controls', await run(`document.querySelector('.theme-mode-toggle').offsetWidth===76 && document.querySelector('.theme-custom-colors').offsetWidth===420`));
      await click('[title="Nebula"]'); await click('.theme-mode-toggle');
      check('mode keeps palette', await run(`document.documentElement.dataset.theme==='light' && layoutFixture.store.getState().settings.themePreset==='nebula'`));
      await shot('nebula-light');
      for (const title of ['Nekko', 'Nebula', 'Terminal', 'Nord', 'Ember', 'Forest', 'Blueberry', 'Spooky']) {
        await click(`[title="${title}"]`);
        check(`${title} keeps light`, await run(`document.documentElement.dataset.theme==='light'`));
        await click('.theme-mode-toggle');
        check(`${title} dark selected`, await run(`document.documentElement.dataset.theme==='dark' && document.querySelector('[title="${title}"]').getAttribute('aria-checked')==='true'`));
        await click('.theme-mode-toggle');
      }
      await click('[title="Nekko"]'); await click('.theme-mode-toggle');
      // A real hover and press on the hidden native window, with a finite clip.
      const rect = await run(`(() => {const b=document.querySelector('[title="Nebula"]').getBoundingClientRect();return {x:Math.round(b.x+b.width/2),y:Math.round(b.y+24)}})()`);
      const motionRect = await run(`(() => {const b=document.querySelector('.theme-picker').getBoundingClientRect();return {x:Math.floor(b.x-8),y:Math.floor(b.y-8),width:Math.ceil(b.width+16),height:Math.ceil(b.height+16)}})()`);
      const frames = [];
      for (let i = 0; i < 50; i++) {
        if (i === 4) win.webContents.sendInputEvent({ type: 'mouseMove', ...rect });
        if (i === 14) win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...rect });
        if (i === 20) win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...rect });
        if (i === 27) win.webContents.sendInputEvent({ type: 'mouseMove', x: 5, y: 5 });
        if (i === 32 || i === 42) await run("document.querySelector('.theme-mode-toggle').click()");
        await sleep(60);
        frames.push((await win.capturePage(motionRect, { stayHidden: true })).resize({width: 1000}).toPNG());
        if (i === 12 || i === 18) {
          const scale = await run(`getComputedStyle(document.querySelector('[title="Nebula"] .theme-swatch')).transform`);
          report.checks[i === 12 ? 'hover transform' : 'press transform'] = scale;
          await shot(i === 12 ? 'hover' : 'pressed');
        }
      }
      check('hover grows', report.checks['hover transform'].startsWith('matrix(1.08,'));
      check('press shrinks', report.checks['press transform'].startsWith('matrix(0.94,'));
      require('./evidence-gif.cjs')(path.join(out, 'theme-motion.gif'), frames, 8);
      // Keyboard radio movement and toggle activation use Chromium's key dispatch.
      await run(`document.querySelector('[title="Nebula"]').focus()`);
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'Right'}); win.webContents.sendInputEvent({type:'keyUp',keyCode:'Right'}); await sleep(150);
      check('arrow selects next theme', await run(`document.activeElement.title==='Terminal' && layoutFixture.store.getState().settings.themePreset==='terminal'`));
      await run(`document.querySelector('.theme-mode-toggle').focus()`);
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'Space'}); win.webContents.sendInputEvent({type:'keyUp',keyCode:'Space'}); await sleep(150);
      check('space switches mode', await run(`document.documentElement.dataset.theme==='light'`));
      await click('.theme-custom-trigger');
      await shot('custom-colors-light');
      // Override one channel via the real editor's native input event.
      await run(`(() => {const input=document.querySelector('.theme-custom-colors input[type="color"]');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(input,'#123456');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await sleep(150); await click('.theme-mode-toggle');
      check('custom color survives mode', await run(`layoutFixture.store.getState().settings.accent==='#123456'`));
      await click('.theme-custom-reset');
      check('reset restores mode default', await run(`layoutFixture.store.getState().settings.accent==='#3fb96a'`));
      await click('.theme-custom-trigger'); await click('[title="Nekko"]');
      win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      check('reduced motion has no transitions', await run(`getComputedStyle(document.querySelector('.theme-swatch')).transitionDuration==='0s' && getComputedStyle(document.querySelector('.theme-mode-thumb')).transitionDuration==='0s'`));
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] }); win.webContents.debugger.detach();
      // A fresh profile can store System's old shipped accents; editing one
      // channel must not resurrect that old value in the untouched channel.
      await run(`(() => {const s=layoutFixture.store;const settings={...s.getState().settings,theme:'dark',themePreset:'system',accent:'#6d5efc',accent2:'#06b6d4'};layoutFixture.bridge.updateSettings(settings);s.setState({settings});s.getState().applyTheme();})()`);
      await sleep(100); await click('.theme-custom-trigger');
      await run(`(() => {const input=document.querySelector('.theme-custom-colors input[type="color"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'#123456');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await sleep(100);
      check('editing System keeps resolved secondary', await run(`layoutFixture.store.getState().settings.accent2==='#06b6d4' && getComputedStyle(document.documentElement).getPropertyValue('--accent-2').trim()==='#c99bb3'`));
      await click('.theme-custom-trigger'); await click('[title="Nekko"]');
    }
    win.setContentSize(390, 844); await sleep(400); await scroll(); await shot('appearance-narrow');
    check('no horizontal page overflow', await run('document.documentElement.scrollWidth <= innerWidth'));
    if (!process.env.NEKKO_THEME_BASELINE) {
      await click('.theme-custom-trigger'); await run("document.querySelector('.theme-custom-colors').scrollIntoView({block:'center'})"); await sleep(300); await shot('custom-colors-narrow');
      check('editor fits narrow card', await run(`(() => {const c=document.querySelector('.theme-custom-colors'),b=c.getBoundingClientRect();return c.scrollWidth<=c.clientWidth && b.right<=innerWidth;})()`));
    }
    await run('layoutFixture.showTheme()'); await sleep(400); await shot('onboarding-narrow');
    win.setContentSize(1440, 968); await sleep(400); await shot('onboarding-desktop');
  } catch(e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report)); app.exit(report.errors.length ? 1 : 0);
});
