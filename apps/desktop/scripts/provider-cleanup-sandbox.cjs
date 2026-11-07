// Synthetic renderer only: hidden, isolated profile, no network or host operations.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], checks: [], errors: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const minX = Math.min(...screen.getAllDisplays().map(d => d.bounds.x)), minY = Math.min(...screen.getAllDisplays().map(d => d.bounds.y));
  const win = new BrowserWindow({ width: 1100, height: 800, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: minX - 1800, y: minY - 1200, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const check = async (name, s) => { if (!await run(s)) throw Error(name); report.checks.push(name); };
  const shot = async name => { const f = path.join(out, name + '.png'); fs.writeFileSync(f, (await win.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG()); report.captures.push(f); };
  fs.cpSync(path.join(__dirname, '../src/renderer/public/providers'), path.join(out, 'providers'), { recursive: true });
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 80 && !await run('!!window.layoutFixture'); i++) await sleep(100);
    await sleep(600);
    for (const width of [1100, 390]) {
      win.setContentSize(width, 800);
      await run('layoutFixture.showProviderCleanup()'); await sleep(600);
      await shot('providers-' + width);
      if (width === 1100 && process.env.NEKKO_TEST_LABEL !== 'before') {
        // Real hidden BrowserWindow frames; no OS focus or synthesized UI.
        const frames = [], started = Date.now();
        for (let frame = 0; frame < 45; frame++) {
          if (frame === 8) await run(`document.querySelector('[aria-label="More providers"]').click()`);
          const image = (await win.capturePage(undefined, { stayHidden: true, stayAwake: true })).resize({width:1100}).toPNG();
          frames.push(image);
          if ([7,8,9,10,12,16].includes(frame)) fs.writeFileSync(path.join(out, 'motion-' + frame + '.png'), image);
          await sleep(16);
        }
        report.motion = {frames:frames.length, elapsedMs:Date.now()-started};
        require('./evidence-gif.cjs')(path.join(out, 'provider-reveal.gif'), frames, Math.max(1, Math.round(report.motion.elapsedMs / frames.length / 10)));
      } else await run(`document.querySelector('[aria-label="More providers"]').click()`);
      await sleep(400);
      await shot('more-' + width);
      if (process.env.NEKKO_TEST_LABEL !== 'before') {
        await check('No duplicate chips or expandable chooser ' + width, `!document.querySelector('.models-connected, .provider-choices, [data-provider-setup]')`);
        await check('Keyboard focus moves to first extra provider ' + width, `document.activeElement?.getAttribute('aria-label') === 'Add Claude on Vertex AI'`);
        await check('Extra providers are inline ' + width, `!!document.querySelector('[aria-label="Add Ollama Cloud"]')`);
        await check('No custom model or disclaimer ' + width, `!document.body.innerText.includes('Custom model id') && !document.body.innerText.includes('not a bill')`);
        await check('Reset countdown is labeled ' + width, `document.body.innerText.includes('Resets in 5d')`);
        await check('No horizontal overflow ' + width, `document.querySelector('main').scrollWidth <= innerWidth`);
        for (const label of ['Claude on Vertex AI', 'Ollama Cloud', 'OpenAI-compatible']) {
          await run(`document.querySelector('[aria-label="Add ${label}"]').click()`); await sleep(150);
          await check('Specific setup for ' + label, `!!document.querySelector('[data-provider-setup]') && !document.querySelector('.provider-choices')`);
          await run(`document.querySelector('[aria-label="Close provider setup"]').click()`);
        }
      }
    }
    if (process.env.NEKKO_TEST_LABEL !== 'before') {
      win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{name:'prefers-reduced-motion',value:'reduce'}] });
      await run('layoutFixture.showProviderCleanup()'); await sleep(250);
      await run(`document.querySelector('[aria-label="More providers"]').click()`); await sleep(50);
      await check('Reduced motion disables expansion animation', `Array.from(document.querySelectorAll('.models-add-revealed')).every(b => getComputedStyle(b).animationName === 'none')`);
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
      win.webContents.debugger.detach();
    }
    // Composer data is synthetic and all bridge calls stay in this fixture.
    await run(`(() => {
      const record = layoutFixture.records[0]; record.workspaceId = 'project'; record.supportingWorkspaceIds = ['docs']; record.mode = 'guardrails';
      layoutFixture.putCachedSession(record);
      const settings = layoutFixture.settings;
      settings.workspaces = [{id:'project',name:'nekko-agent',path:'/fixture/nekko-agent'}, {id:'docs',name:'docs',path:'/fixture/docs'}];
      layoutFixture.bridge.getSettings = async () => settings;
      layoutFixture.store.setState({settings, sessions:[record], running:new Set()});
    })()`);
    for (const surface of ['window', 'chat']) for (const width of [1100, 390]) {
      win.setContentSize(width, 800);
      await run(`layoutFixture.showComposer('${surface}')`); await sleep(600);
      await shot('composer-' + surface + '-' + width);
      if (process.env.NEKKO_TEST_LABEL !== 'before') {
        await check('Folders immediately follow plus ' + width, `(() => { const plus = document.querySelector('[aria-label="Add a photo, video, file, folder, or skill"]'); return plus.parentElement.nextElementSibling?.querySelector('[aria-label^="Selected folders"]') !== null; })()`);
        await check('Folder button never overlaps permissions ' + surface + width, `(() => {const folder = document.querySelector('[aria-label^="Selected folders"]').getBoundingClientRect(); const permission = document.querySelector('[data-asks-first]').getBoundingClientRect(); return folder.right <= permission.left;})()`);
        await check('One permission control only ' + surface + width, `document.querySelectorAll('[data-asks-first]').length === 1`);
        await check('Both folder names visible ' + width, `document.querySelector('[aria-label^="Selected folders"]')?.textContent.includes('nekko-agent, docs')`);
        await check('Icon-only permission with divider ' + width, `(() => { const b = document.querySelector('[data-asks-first]'); return b && !b.textContent.trim() && b.getAttribute('aria-label')?.includes('Permissions') && b.previousElementSibling?.hasAttribute('data-permissions-divider'); })()`);
        await run(`document.querySelector('[data-asks-first]').click()`); await sleep(150);
        await check('Permission options open ' + width, `document.querySelectorAll('[data-asks-menu] [role="menuitemradio"]').length === 3`);
        await shot('permissions-' + surface + '-' + width);
        await run(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
      }
    }
    for (const surface of ['add', 'onboarding', 'choices']) for (const width of [1100, 390]) {
      win.setContentSize(width,800);
      await run(`layoutFixture.showProviderSetupCleanup('${surface}')`); await sleep(300);
      await shot(surface + '-' + width);
      if (process.env.NEKKO_TEST_LABEL !== 'before') await check('No custom model entry in ' + surface + width, `!document.body.innerText.includes('Custom model id')`);
    }
    report.visible = win.isVisible();
  } catch (e) { report.failed = true; report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.failed || report.errors.length ? 1 : 0);
});
