const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through command-center-integration.cjs');
const runDir = path.join(out, new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(runDir, { recursive: true });
app.setPath('userData', path.join(runDir, 'profile'));
app.setPath('sessionData', path.join(runDir, 'profile'));
const report = { checks: [], errors: [], captures: [], visuallyInspected: false };
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, done) => done(false));
  const win = new BrowserWindow({ width: 1200, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: Math.min(...screen.getAllDisplays().map(d => d.bounds.x)) - 1400, y: Math.min(...screen.getAllDisplays().map(d => d.bounds.y)) - 1100, title: 'Synthetic Command Center verification', webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.on('focus', () => { report.errors.push('Verification window took OS focus'); process.exitCode = 1; });
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const check = async (name, expression) => { await sleep(180); if (!await run(expression)) throw Error(name); report.checks.push(name); };
  const click = async (text, selector = null) => {
    await run(`(() => {
      const scope = ${JSON.stringify(selector)};
      const root = scope === null ? document : document.querySelector(scope);
      const text = ${JSON.stringify(text)};
      const b = [...root.querySelectorAll('button')].find(b => b.textContent.trim() === text);
      if (!b) throw Error('Missing button ' + text);
      b.focus(); b.click();
    })()`);
    await sleep(180);
  };
  const reset = async () => { await run('window.integration.reset()'); await sleep(350); };
  const open = async category => { await run("document.querySelector('[data-wall-add-button]').click()");await sleep(180); if (category) { await run(`[...document.querySelectorAll('.agent-window-picker__option')].find(b=>b.querySelector('strong')?.textContent===${JSON.stringify(category)}).click()`); await sleep(180); } };
  const image = async () => { await open('Media'); await run("[...document.querySelectorAll('.agent-window-picker button')].find(b=>b.textContent.includes('Create image session')).click()"); await sleep(200); };
  const capture = async name => { await sleep(350); fs.writeFileSync(path.join(runDir, name + '.png'), (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG()); report.captures.push(path.join(runDir, name + '.png')); };
  try {
    await win.loadFile(path.join(out, 'index.html')); win.showInactive(); await sleep(900);
    await check('mounted full CommandCenterView', "(document.body.textContent.includes('Agents') || document.body.textContent.includes('Command Center')) && !!document.querySelector('[data-command-wall]')");
    if (!process.env.NEKKO_TEST_REVISION) {
    win.setContentSize(1200, 400); await sleep(350);
    await check('short viewport keeps chat wall visible without composer overlap', "(()=>{const wall=document.querySelector('.command-wall-layout').getBoundingClientRect();const composer=document.querySelector('[data-wall-composer]').getBoundingClientRect();const column=document.querySelector('.wall-column');return wall.height>=160&&wall.bottom<=composer.top+1&&column.scrollHeight<=column.clientHeight+1;})()");
    win.setContentSize(1200, 900); await sleep(350);
    await open();
    await check('picker initial focus', "document.activeElement.classList.contains('agent-window-picker__option')");
    await run("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await check('Escape dismissal restores toolbar focus', "!document.querySelector('.agent-window-picker') && document.activeElement.textContent.includes('Add window')");
    await open(); await run("document.querySelector('[data-wall-add-button]').click()");await sleep(180);
    await check('toolbar toggle dismisses and restores focus', "!document.querySelector('.agent-window-picker') && document.activeElement.textContent.includes('Add window')");
    await reset(); await run('integration.failures.create=true'); await image();
    await check('creation failure stays open with error', "!!document.querySelector('[role=alert]') && integration.records().length===1");
    await run('integration.failures.create=false'); await run("[...document.querySelectorAll('.agent-window-picker button')].find(b=>b.textContent.includes('Create image session')).click()");
    await check('creation retry configures image and dismisses', "!document.querySelector('.agent-window-picker') && integration.state().sessions.some(s=>s.chatType==='image') && integration.calls.filter(c=>c.method==='create').length===2");
    await reset(); await run('integration.failures.options=true'); await image();
    await check('options failure deletes new session', "!!document.querySelector('[role=alert]') && integration.records().length===1 && integration.calls.some(c=>c.method==='cleanup')");
    await run('integration.failures.options=false'); await run("[...document.querySelectorAll('.agent-window-picker button')].find(b=>b.textContent.includes('Create image session')).click()");
    await check('options retry succeeds after cleanup', "!document.querySelector('.agent-window-picker') && integration.records().length===2");
    await reset(); await run('integration.failures.options=true;integration.failures.cleanup=true'); await image();
    await check('cleanup failure reports reusable session', "document.querySelector('[role=alert]').textContent.includes('Retry will reuse') && integration.records().length===2");
    await run('integration.failures.options=false'); await run("[...document.querySelectorAll('.agent-window-picker button')].find(b=>b.textContent.includes('Create image session')).click()");
    await check('cleanup-failure retry does not duplicate', "!document.querySelector('.agent-window-picker') && integration.calls.filter(c=>c.method==='create').length===1 && integration.state().sessions.filter(s=>s.id==='new-1').length===1");
    await click('Focus'); await check('Grid to Focus', "document.querySelector('[data-wall-layout]').dataset.wallLayout==='focus'");
    await click('Dynamic'); await check('Focus to Grid', "document.querySelector('[data-wall-layout]').dataset.wallLayout==='grid'");
    await reset(); await open('Chat');
    await check('long catalog scrolls inside fieldset without covering Create chat', "(()=>{const list=document.querySelector('.agent-window-picker [role=listbox]');const field=document.querySelector('.agent-window-picker__models');const create=document.querySelector('.agent-window-picker__primary');return list.scrollHeight>list.clientHeight&&list.getBoundingClientRect().bottom<=field.getBoundingClientRect().bottom+1&&field.getBoundingClientRect().bottom<=create.getBoundingClientRect().top;})()");
    await check('layout toggle precedes agent filter', "!!(document.querySelector('[aria-label=\"Wall layout\"]').compareDocumentPosition(document.querySelector('[aria-label=\"Show\"]')) & Node.DOCUMENT_POSITION_FOLLOWING)");
    await check('creation details share the Add tile', "!!document.querySelector('.command-wall-add-tile #wall-window-picker')");
    await check('creation does not offset pane stage', "getComputedStyle(document.querySelector('.command-wall-pane-stage')).top==='0px'");
    await run("[...document.querySelectorAll('.agent-window-picker button')].find(b=>b.textContent.includes('Fixture model')).click()"); await sleep(180); await click('Create chat');
    await check('chat model creation configures selected provider/model', "integration.calls.some(c=>c.method==='options'&&c.options.providerId==='fixture'&&c.options.modelId==='fixture-model'&&c.options.autoModel===false) && !document.querySelector('.agent-window-picker')");
    await reset(); await open('Terminal'); await click('Create terminal');
    await check('terminal creation passes workspace and dismisses', "!document.querySelector('.agent-window-picker') && integration.state().terminals.length===1 && integration.calls.find(c=>c.method==='terminal').options.workspaceId==='synthetic-project'");
    await reset(); await open('Chat');
    await run("[...document.querySelectorAll('.agent-window-picker button')].find(b=>b.textContent.includes('Existing conversation')).click()");
    await check('existing chat enters wall without creation', "!document.querySelector('.agent-window-picker') && !integration.calls.some(c=>c.method==='create') && document.body.textContent.includes('1 agent')");
    await open('Chat'); await run("[...document.querySelectorAll('.agent-window-picker button')].find(b=>b.textContent.includes('Existing conversation')).click()");
    await check('existing chat repeated entry is deduplicated', "document.body.textContent.includes('1 agent')");
    }
    for (const theme of ['light', 'dark']) {
      await run(`document.documentElement.dataset.theme='${theme}'`);
      for (const [width, label] of [[1200, 'desktop'], [400, 'narrow']]) {
        win.setContentSize(width, 900); await reset(); await capture(`full-grid-${theme}-${label}`);
        win.setContentSize(width,400); await capture(`short-grid-${theme}-${label}`); win.setContentSize(width,900);
        await run('integration.dashboard()'); await sleep(900); await capture(`dashboard-${theme}-${label}`); await run("document.querySelector('[aria-label=\"Utilization dock panel\"]').scrollIntoView({block:'start'})"); await capture(`quota-${theme}-${label}`); await run("document.querySelector('[aria-label=\"Hardware dock panel\"]').scrollIntoView({block:'end'})"); await capture(`monitors-${theme}-${label}`); await reset();
        await open(); await capture(`full-picker-${theme}-${label}`);
        await run("[...document.querySelectorAll('.agent-window-picker__option')].find(b=>b.querySelector('strong')?.textContent==='Chat').click()"); await capture(`long-catalog-${theme}-${label}`);
        for (const [key,code,mode] of [['2','Digit2','grid'],['3','Digit3','fixed'],['1','Digit1','focus']]) {
          await click(mode[0].toUpperCase()+mode.slice(1)); if (mode === 'fixed') await run("document.querySelector('[aria-label=\"3 columns by 2 rows\"]')?.click()"); await sleep(400);
          await run("(document.querySelector('.command-wall-add-tile') || document.querySelector('#wall-window-picker'))?.scrollIntoView({block:'start'})"); await capture(`create-${mode}-${theme}-${label}`);
          await run("document.querySelector('.agent-window-picker__primary')?.scrollIntoView({block:'end'})"); await capture(`create-${mode}-actions-${theme}-${label}`);
        }
        await run("document.querySelector('[data-wall-add-button]').click()");await sleep(180); await click('Focus'); await capture(`full-focus-${theme}-${label}`);
        await run("integration.route('workspace')"); await sleep(500);
        await run("(()=>{const b=document.querySelector('[title=\"New agent with a terminal\"]'); b.focus(); b.dispatchEvent(new FocusEvent('focusin',{bubbles:true}));})()"); await capture(`workspace-image-menu-${theme}-${label}`);
      }
    }
    if (!process.env.NEKKO_TEST_REVISION) {
      await run("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Media gen').click()");
      await check('workspace image entry uses real store creation and options', "integration.calls.some(c=>c.method==='options'&&c.options.chatType==='image') && integration.state().activeSessionId==='new-1' && integration.state().workspaces.some(w=>w.anchor.refId==='new-1')");
    }
    win.setContentSize(1200,900); await reset(); await run('integration.dashboard()'); await sleep(900);
    if (!process.env.NEKKO_TEST_REVISION) {
      await run("document.querySelector('[aria-label=\"Switch to offline mode\"]').click()");
      await check('offline click targets the owning session', "integration.calls.some(c=>c.method==='options'&&c.id==='existing'&&c.options.offline===true) && !!document.querySelector('[aria-label=\"Switch to online mode\"]')");
      await run("document.querySelector('[aria-label=\"Refresh provider quota\"]').click()");
      await check('explicit refresh requests provider poll', "integration.calls.some(c=>c.method==='limits'&&c.key==='fixture'&&c.refresh===true)");
      await run("document.querySelector('.wall-dock__panel-header').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',altKey:true,bubbles:true}))");
      await sleep(900);
      await check('keyboard reorder persists', "integration.calls.some(c=>c.method==='settings'&&c.patch.commandWall?.dock.panelOrder[0]!=='hardware')");
      win.webContents.debugger.attach('1.3');
      let interceptedDrag=null; const dragListener=(_event,method,params)=>{if(method==='Input.dragIntercepted')interceptedDrag=params.data;}; win.webContents.debugger.on('message',dragListener); await win.webContents.debugger.sendCommand('Input.setInterceptDrags',{enabled:true});
      const points=await run("[...document.querySelectorAll('.wall-dock__panel-header')].slice(0,2).map(h=>{const r=h.getBoundingClientRect();return {x:r.x+90,y:r.y+r.height/2}})");
      const oldOrder=await run("[...document.querySelectorAll('.wall-dock__panel-header h2')].map(e=>e.textContent).join(',')");
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',...points[0]});
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',...points[0],button:'left',clickCount:1});
      for(let i=1;i<=8;i++) { await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:points[0].x,y:points[0].y+(points[1].y-points[0].y)*i/8,button:'left',buttons:1}); await sleep(50); }
      if(!interceptedDrag) throw Error('Desktop drag did not start');
      for(const type of ['dragEnter','dragOver','drop']) await win.webContents.debugger.sendCommand('Input.dispatchDragEvent',{type,...points[1],data:interceptedDrag});
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',...points[1],button:'left',clickCount:1});
      win.webContents.debugger.off('message',dragListener);
      await sleep(900);
      await check('desktop pointer drag reorders panels', "[...document.querySelectorAll('.wall-dock__panel-header h2')].map(e=>e.textContent).join(',')!=="+JSON.stringify(oldOrder));
      win.webContents.debugger.detach();
    }
    // Timed PNG frames form a portable motion recording without screen permissions.
    win.setContentSize(1200, 900); await reset(); await run("document.documentElement.dataset.theme='light'");
    const motion = path.join(runDir, 'motion'); fs.mkdirSync(motion);
    for (let frame = 0; frame < 36; frame++) {
      if (frame === 4 || frame === 16) await run("document.querySelector('[data-wall-add-button]').click()");await sleep(180);
      if (frame === 22) await click('Focus');
      if (frame === 29) await click('Dynamic');
      fs.writeFileSync(path.join(motion, `${String(frame).padStart(3, '0')}.png`), (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG());
      await sleep(100);
    }
    const encoded = require('node:child_process').spawnSync('ffmpeg', ['-y', '-framerate', '10', '-i', path.join(motion, '%03d.png'), '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(runDir, 'full-view-motion.mp4')], { encoding: 'utf8', windowsHide: true });
    if (encoded.status !== 0) throw Error(encoded.stderr);
    report.captures.push(path.join(runDir, 'full-view-motion.mp4'));
    if (!process.env.NEKKO_TEST_REVISION) {
      win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await reset(); await open();
      await check('reduced-motion picker has no reveal animation', "matchMedia('(prefers-reduced-motion: reduce)').matches && getComputedStyle(document.querySelector('.agent-window-picker')).animationName==='none'");
      win.webContents.debugger.detach();
      win.setContentSize(400, 900); await reset(); await open('Chat');
      await check('narrow picker is within wall horizontal bounds', "(()=>{const p=document.querySelector('.agent-window-picker').getBoundingClientRect();return p.left>=0&&p.right<=innerWidth;})()");
      await check('existing conversation remains reachable at narrow width', "[...document.querySelectorAll('.agent-window-picker button')].some(b=>b.textContent.includes('Existing conversation')&&!b.disabled)");
    }
    win.setContentSize(1200,900); await reset(); await run('integration.dashboard()'); await sleep(900);
    const dashboardMotion=path.join(runDir,'dashboard-motion');fs.mkdirSync(dashboardMotion);
    for(let frame=0;frame<32;frame++) {
      await run(`document.querySelector('.pixel-mascot').getAnimations({subtree:true}).forEach(a=>{a.pause();a.currentTime=${frame*1000}})`);
      if(frame===10&&!process.env.NEKKO_TEST_REVISION) await run("document.querySelector('.wall-dock__panel-header').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',altKey:true,bubbles:true}))");
      await sleep(100);fs.writeFileSync(path.join(dashboardMotion,String(frame).padStart(3,'0')+'.png'),(await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG());
    }
    const video=require('node:child_process').spawnSync('ffmpeg',['-y','-framerate','4','-i',path.join(dashboardMotion,'%03d.png'),'-vf','pad=ceil(iw/2)*2:ceil(ih/2)*2','-c:v','libx264','-pix_fmt','yuv420p',path.join(runDir,'dashboard-motion.mp4')],{encoding:'utf8',windowsHide:true});if(video.status!==0)throw Error(video.stderr);
    report.captures.push(path.join(runDir,'dashboard-motion.mp4'));
    if (win.isFocused() || screen.getAllDisplays().some(d => { const b=win.getBounds(); return b.x < d.bounds.x+d.bounds.width && b.x+b.width > d.bounds.x && b.y < d.bounds.y+d.bounds.height && b.y+b.height > d.bounds.y; }) || report.errors.some(e => /Verification window/.test(e))) throw Error('Background verification visibility/focus invariant failed');
    report.background = { visible: win.isVisible(), focused: win.isFocused(), offscreen: win.getBounds().x + win.getBounds().width <= Math.min(...screen.getAllDisplays().map(d => d.bounds.x)) };
    report.success = true;
  } catch (e) { report.errors.push(String(e)); report.success = false; process.exitCode = 1; }
  finally { fs.writeFileSync(path.join(runDir, 'status.json'), JSON.stringify(report, null, 2)); fs.writeFileSync(path.join(out, 'latest-run.txt'), runDir); console.log(JSON.stringify({ runDir, ...report }, null, 2)); win.destroy(); app.exit(report.success ? 0 : 1); }
});
