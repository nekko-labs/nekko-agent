// Repository-row regression fixture. Synthetic host, disposable profile, no network or OS input.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch with NEKKO_REPO_ACTIONS=1 through agent-sidebar-integration.cjs');
const base = !!process.env.NEKKO_TEST_REVISION;
const dir = path.join(out, base ? 'before' : 'after');
fs.mkdirSync(dir, { recursive: true });
app.setPath('userData', path.join(dir, 'profile'));
app.setPath('sessionData', path.join(dir, 'profile'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((request, done) => done({ cancel: !/^(file:|data:|blob:)/.test(request.url) }));
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, done) => done(false));
  const bounds = screen.getAllDisplays().map(display => display.bounds);
  const win = new BrowserWindow({ width: 1200, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true,
    x: Math.min(...bounds.map(b => b.x)) - 1600, y: Math.min(...bounds.map(b => b.y)) - 1600,
    title: 'Synthetic repository actions verification', webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  const report = { checks: [], errors: [], baseline: [], visuallyInspected: false };
  win.on('focus', () => report.errors.push('Fixture took OS focus'));
  const run = source => win.webContents.executeJavaScript(source, true);
  const check = async (name, source) => { await sleep(300); if (!await run(source)) throw Error(name); report.checks.push(name); };
  const capture = async name => { await sleep(300); fs.writeFileSync(path.join(dir, name + '.png'), (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG()); };
  const setup = async (mode, orientation = 'vertical', filter = 'all') => {
    await run('integration.reset()'); await sleep(300);
    await run(`(async () => {
      const state = integration.state();
      state.settings.workspaces.push({id:'repo-a',name:'Repository A',path:'/synthetic/a'}, {id:'repo-b',name:'Repository B',path:'/synthetic/b'});
      state.settings.defaultWorkspaceIds = ['repo-a'];
      Object.assign(integration.records()[0], {workspaceId:'repo-a'});
      integration.state().setActiveProject('repo-a');
      const wall = state.settings.commandWall;
      await integration.configureWall({...wall, hero:'existing', filter:${JSON.stringify(filter)}, layout:{...wall.layout,mode:${JSON.stringify(mode)}}, agentPanel:{show:true,orientation:${JSON.stringify(orientation)}}});
    })()`);
    await sleep(500);
    if (win.getContentSize()[0] < 768) { await run("document.querySelector('[aria-label=\"Open agent list\"]')?.click()"); await sleep(200); }
  };
  const click = async kind => { await run(`document.querySelector('[data-agent-group="repo-b"] [title="New ${kind === 'chat' ? 'agent in this project' : 'terminal in project'}"]').click()`); await sleep(450); };
  try {
    await win.loadFile(path.join(out, 'index.html')); win.showInactive(); await sleep(700);
    for (const theme of ['light', 'dark']) for (const width of [1200, 400]) for (const orientation of ['vertical', 'horizontal']) {
      win.setContentSize(width, 900);
      for (const kind of ['chat', 'terminal']) {
        await setup('focus', orientation);
        await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
        await click(kind);
        await check('fixture uses requested orientation', `document.querySelector('.wall-agent-workspace').dataset.tabs===${JSON.stringify(orientation === 'horizontal' ? 'top' : 'left')}`);
        await check('fixture uses Focus layout', "document.querySelector('[data-wall-layout]').dataset.wallLayout==='focus'");
        if (base) report.baseline.push({theme,width,orientation,kind, result:await run("({calls:integration.calls.filter(c=>c.method==='create'||c.method==='terminal'),hero:integration.state().settings.commandWall.hero,visible:[...document.querySelectorAll('[data-wall-hero]')].map(e=>e.dataset.gridCell)})")});
        else {
          await check(`${theme}/${width}/${orientation} ${kind} repository payload`, kind === 'chat' ? "integration.calls.some(c=>c.method==='create'&&c.workspaceId==='repo-b')&&!integration.calls.some(c=>c.method==='terminal')" : "integration.calls.some(c=>c.method==='terminal'&&c.options.workspaceId==='repo-b')");
          await check(`${kind} is visible in Focus`, `!!document.querySelector('[data-wall-hero][data-grid-cell="${kind}:${kind === 'chat' ? 'new' : 'terminal'}-1"]')`);
          await check('mobile overlay dismissed after success', "!document.querySelector('[aria-label=\"Open agent list\"]') || document.querySelector('[aria-label=\"Open agent list\"]').getAttribute('aria-expanded')==='false'");
          await check('active repository unchanged', "integration.state().activeProjectId==='repo-a'");
        }
        await capture(`${kind}-${theme}-${width}-${orientation}`);
      }
    }
    if (!base) {
      win.setContentSize(1200,900);
      for (const mode of ['focus','grid','fixed']) for (const kind of ['chat','terminal']) {
        await setup(mode, 'vertical', kind === 'chat' ? 'terminal' : 'chat');
        await click(kind);
        await check(`${mode} ${kind} leaves filter visible`, "integration.state().settings.commandWall.filter==='all'");
        await check(`${mode} is preserved`, `document.querySelector('[data-wall-layout]').dataset.wallLayout===${JSON.stringify(mode)}`);
        await check('existing pane retained', "!!document.querySelector('[data-grid-cell=\"chat:existing\"]')");
        await check('one host creation', "integration.calls.filter(c=>c.method==='create'||c.method==='terminal').length===1");
      }
      for (const kind of ['chat','terminal']) {
        await setup('focus');
        await run(`integration.failures.${kind === 'chat' ? 'create' : 'terminal'}=true`);
        await click(kind);
        await check(`${kind} failure reports toast`, "integration.state().toasts.some(t=>t.kind==='error'&&t.message.includes('Repository B')&&t.message.includes('Synthetic'))");
        await check('failure is rendered to the user', "document.body.textContent.includes('Could not') && document.body.textContent.includes('Synthetic')");
        await capture(`${kind}-failure-dark-1200`);
        await check('failure preserves current pane', "!!document.querySelector('[data-wall-hero][data-grid-cell=\"chat:existing\"]')");
        await run(`integration.failures.${kind === 'chat' ? 'create' : 'terminal'}=false`);
        await click(kind);
        await check('retry creates only one record', kind === 'chat' ? "integration.records().length===2" : "integration.state().terminals.length===1");
      }
      await setup('focus');
      await run('integration.failures.delay=500');
      await run("(()=>{const b=document.querySelector('[data-agent-group=\"repo-b\"] [title=\"New agent in this project\"]');b.click();b.click()})()");
      await sleep(900);
      await check('rapid clicks create once', "integration.calls.filter(c=>c.method==='create').length===1");
      // A real press that drifts a few pixels while held. The header row is a
      // project drag source, and before the fix that drift began a drag and the
      // + never created anything. Renderer input events only, no OS input.
      for (const kind of ['chat', 'terminal']) {
        await setup('grid');
        const sel = `[data-agent-group="repo-b"] [title="New ${kind === 'chat' ? 'agent in this project' : 'terminal in project'}"]`;
        const r = await run(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
        win.webContents.sendInputEvent({ type: 'mouseMove', x: r.x, y: r.y }); await sleep(150);
        win.webContents.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'left', clickCount: 1 });
        for (let i = 1; i <= 6; i++) { win.webContents.sendInputEvent({ type: 'mouseMove', x: r.x + i, y: r.y, button: 'left', modifiers: ['leftButtonDown'] }); await sleep(16); }
        win.webContents.sendInputEvent({ type: 'mouseUp', x: r.x + 6, y: r.y, button: 'left', clickCount: 1 });
        await sleep(600);
        await check(`${kind} press that drifts still creates in the repository`, kind === 'chat' ? "integration.calls.some(c=>c.method==='create'&&c.workspaceId==='repo-b')" : "integration.calls.some(c=>c.method==='terminal'&&c.options.workspaceId==='repo-b')");
      }
      for (const kind of ['chat', 'terminal']) {
        await setup('focus'); await run("document.querySelector('[data-agent-group=\"repo-b\"] [data-sidebar-group]').click()");
        await click(kind);
        await check('collapsed repository creation remains visible', `!!document.querySelector('[data-wall-hero][data-grid-cell="${kind}:${kind === 'chat' ? 'new' : 'terminal'}-1"]')`);
      }
      // Record actual renderer frames, never OS input or a foreground window.
      await setup('focus');
      await run("document.documentElement.dataset.theme='light'");
      const { GifFrame, GifUtil } = require('gifwrap');
      const frames = [];
      for (let i=0; i<30; i++) {
        if (i===8) await run("document.querySelector('[data-agent-group=\"repo-b\"] [title=\"New agent in this project\"]').click()");
        if (i===20) await run("document.querySelector('[data-agent-group=\"repo-b\"] [title=\"New terminal in project\"]').click()");
        const image = (await win.capturePage(undefined, {stayHidden:true, stayAwake:false})).resize({width:720});
        const bitmap = image.toBitmap();
        for (let j=0;j<bitmap.length;j+=4) { const b=bitmap[j];bitmap[j]=bitmap[j+2];bitmap[j+2]=b; }
        frames.push(new GifFrame(image.getSize().width,image.getSize().height,bitmap,{delayCentisecs:15}));
        await sleep(150);
      }
      GifUtil.quantizeDekker(frames,256);
      await GifUtil.write(path.join(dir,'repo-actions-motion.gif'),frames,{loops:0});

    }
    if (report.errors.length || win.isFocused()) throw Error('Fixture focus invariant failed');
    report.success = true;
  } catch (error) { report.errors.push(String(error)); report.success = false; }
  finally { fs.writeFileSync(path.join(dir,'status.json'),JSON.stringify(report,null,2)); console.log(JSON.stringify({dir,...report},null,2)); win.destroy(); app.exit(report.success ? 0 : 1); }
});
