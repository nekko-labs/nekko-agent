// Synthetic Agents-wall polish evidence; never connects to the user's host or profile.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through wall-polish-integration.cjs');
const base = !!process.env.NEKKO_TEST_REVISION;
const dir = path.join(out, base ? 'before' : 'after');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
app.setPath('userData', path.join(dir, 'profile'));
app.setPath('sessionData', path.join(dir, 'profile'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const addClick = "(document.querySelector('[data-wall-add-button]') || [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Add window')).click()";
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=';

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((request, done) => done({ cancel: !/^(file:|data:|blob:)/.test(request.url) }));
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, done) => done(false));
  const left = Math.min(...screen.getAllDisplays().map(d => d.bounds.x));
  const win = new BrowserWindow({
    width: 1400, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true,
    x: left - 3000, y: -2000, title: 'Synthetic Agents wall polish verification',
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  const report = { checks: [], errors: [], visuallyInspected: false };
  win.on('focus', () => report.errors.push('Fixture took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push('console: ' + e.message); });
  const run = source => win.webContents.executeJavaScript(source, true);
  const check = async (name, source) => {
    await sleep(200);
    const ok = !!await run(source);
    report.checks.push({ name, passed: ok });
    if (!ok && !base) throw Error(name);
  };
  const capture = async (name, rect) => {
    await sleep(350);
    await run('document.getAnimations().filter(a => a instanceof CSSTransition).forEach(a => a.finish())');
    fs.writeFileSync(path.join(dir, name + '.png'), (await win.capturePage(rect, { stayHidden: true, stayAwake: false })).toPNG());
  };
  const reset = async () => { await run('integration.reset()'); await sleep(900); };
  const theme = t => run(`document.documentElement.dataset.theme='${t}'`);
  const sidebarCard = title => `[...document.querySelectorAll('div[role=button]')].find(card => card.getAttribute('title')?.includes(${JSON.stringify(title)}))`;
  try {
    await win.loadFile(path.join(out, 'index.html'));
    win.showInactive();
    await sleep(1000);
    for (const t of ['dark', 'light']) {
      win.setContentSize(1400, 900);
      await reset(); await theme(t); await sleep(300);
      await capture(`wall-${t}`);
      // Header row and the composer edges, cropped for detail.
      await capture(`header-${t}`, { x: 0, y: 0, width: 1400, height: 110 });
      const composer = await run("(()=>{const r=document.querySelector('[data-wall-composer]').getBoundingClientRect();return {x:Math.max(0,Math.floor(r.x)-24),y:Math.max(0,Math.floor(r.y)-24),width:Math.ceil(r.width)+48,height:Math.ceil(r.height)+48}})()");
      await capture(`composer-${t}`, composer);
      // Attachments: images must add height, not take it from the text box.
      const editorBefore = await run("document.querySelector('[data-wall-composer] [contenteditable]').getBoundingClientRect().height");
      await run(`(()=>{const i=document.querySelector('[data-wall-composer] [contenteditable]'); i.focus(); const dt=new DataTransfer(); for (let n=0;n<3;n++) dt.items.add(new File([Uint8Array.from(atob('${PNG}'),c=>c.charCodeAt(0))],'fixture'+n+'.png',{type:'image/png'})); i.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:dt}))})()`);
      await sleep(600);
      await check(`attachments keep editor height (${t})`, `(()=>{const e=document.querySelector('[data-wall-composer] [contenteditable]').getBoundingClientRect(); return e.height >= ${editorBefore} - 1})()`);
      await check(`attachments do not overlap editor (${t})`, "(()=>{const imgs=[...document.querySelectorAll('[data-wall-composer] img[alt^=\"Pending attachment\"]')];const e=document.querySelector('[data-wall-composer] [contenteditable]').getBoundingClientRect();return imgs.length>0&&imgs.every(i=>i.getBoundingClientRect().bottom<=e.top+1)})()");
      await check(`composer frame contains attachments (${t})`, "(()=>{const p=document.querySelector('[data-wall-composer]').getBoundingClientRect();const c=document.querySelector('[data-wall-composer] .composer').getBoundingClientRect();return c.bottom<=p.bottom+1&&c.top>=p.top-1})()");
      const withImages = await run("(()=>{const r=document.querySelector('[data-wall-composer]').getBoundingClientRect();return {x:Math.max(0,Math.floor(r.x)-24),y:Math.max(0,Math.floor(r.y)-24),width:Math.ceil(r.width)+48,height:Math.ceil(r.height)+48}})()");
      await capture(`composer-images-${t}`, withImages);
      // Prompt suggestions: chip only, beside the microphone.
      await reset(); await theme(t);
      await run("(()=>{const e=document.querySelector('[data-wall-composer] [contenteditable]');e.focus();e.textContent='Refactor the wall composer so it handles attachments correctly';e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'x'}))})()");
      await sleep(600);
      await check(`suggestions chip sits left of the microphone (${t})`, "(()=>{const chip=document.querySelector('[data-wall-composer] [data-prompt-suggestions]');const mic=document.querySelector('[data-wall-composer] [aria-label*=ictat]')||document.querySelector('[data-wall-composer] [title*=ictat]');if(!chip||!mic)return false;const c=chip.getBoundingClientRect(),m=mic.getBoundingClientRect();return c.right<=m.left+1&&Math.abs((c.top+c.bottom)/2-(m.top+m.bottom)/2)<12})()");
      await capture(`composer-suggestions-${t}`, await run("(()=>{const r=document.querySelector('[data-wall-composer]').getBoundingClientRect();return {x:Math.max(0,Math.floor(r.x)-24),y:Math.max(0,Math.floor(r.y)-24),width:Math.ceil(r.width)+48,height:Math.ceil(r.height)+48}})()"));
      await run("document.querySelector('[data-wall-composer] [data-prompt-suggestions]')?.click()"); await sleep(300);
      await capture(`composer-suggestions-open-${t}`);
      // Side panel: grid selection keeps grid; a chat not on the wall joins it.
      await reset(); await theme(t);
      await run(`${sidebarCard('Analyze post-merge perf trace')}.click()`); await sleep(500);
      await check(`grid card click keeps grid (${t})`, "document.querySelector('[data-wall-layout]').dataset.wallLayout==='grid'");
      await check(`grid card click selects the matching window (${t})`, "document.querySelector('[data-wall-selected]')?.dataset.gridCell==='chat:beta'");
      await run(`${sidebarCard('Chat not on the wall')}.click()`); await sleep(600);
      await check(`off-wall chat opens in the grid (${t})`, "document.querySelector('[data-wall-layout]').dataset.wallLayout==='grid' && !!document.querySelector('[data-grid-cell=\"chat:outside\"]') && document.querySelector('[data-wall-selected]')?.dataset.gridCell==='chat:outside'");
      await capture(`grid-select-${t}`);
      // Panel close button and orientation toggle.
      await reset(); await theme(t);
      await check(`panel has no Agents header text (${t})`, "!document.querySelector('[data-agent-panel]')?.querySelector('span.text-sm.font-semibold')");
      await run("document.querySelector('[aria-label=\"Close the agent panel\"]')?.click()"); await sleep(400);
      await check(`panel close hides it (${t})`, "!document.querySelector('[data-agent-panel]')");
      await capture(`panel-closed-${t}`);
      await run("document.querySelector('[aria-label=\"Show the agent panel\"]')?.click()"); await sleep(400);
      await check(`panel reopens (${t})`, "!!document.querySelector('[data-agent-panel]')");
      await run("document.querySelector('[aria-label=\"Show agents in a row\"]')?.click()"); await sleep(500);
      await check(`horizontal panel sits inline above the wall (${t})`, "(()=>{const p=document.querySelector('[data-agent-panel]');return p?.dataset.orientation==='horizontal'&&p.getBoundingClientRect().height<200})()");
      await capture(`panel-horizontal-${t}`);
      // Add window: next to the composer, with an arrow to the new slot, no edge rails.
      await reset(); await theme(t);
      report.overflow = await run("(()=>{const c=document.querySelector('.wall-column');const r=c.getBoundingClientRect();return {sw:c.scrollWidth,cw:c.clientWidth,wide:[...c.querySelectorAll('*')].filter(e=>e.getBoundingClientRect().right>r.right+1).slice(0,6).map(e=>e.className+':'+Math.round(e.getBoundingClientRect().right-r.right)), kids:[...c.children].map(e=>e.className+' w'+Math.round(e.getBoundingClientRect().width)+' sw'+e.scrollWidth), crect:Math.round(r.width)}})()");
      await check(`wall column has no horizontal overflow (${t})`, "(()=>{const c=document.querySelector('.wall-column');return c.scrollWidth<=c.clientWidth+1})()");
      await check(`no edge add rails (${t})`, "!document.querySelector('.command-wall-add-rail')");
      await check(`add window sits right of the composer (${t})`, "(()=>{const b=document.querySelector('[data-wall-add-button]');const c=document.querySelector('[data-wall-composer]');if(!b||!c)return false;const r=b.getBoundingClientRect(),q=c.getBoundingClientRect();return r.left>=q.right-1&&r.top<q.bottom&&r.bottom>q.top})()");
      // One click only: base revisions have the toolbar button, current ones the composer's.
      await run(addClick); await sleep(500);
      report.addDebug = await run("JSON.stringify({expanded:document.querySelector('[data-wall-add-button]')?.getAttribute('aria-expanded'), picker:!!document.querySelector('#wall-window-picker'), tile:!!document.querySelector('.command-wall-add-tile'), zone:!!document.querySelector('.command-wall-add-zone')})");
      await check(`add window opens the picker slot (${t})`, "!!document.querySelector('.command-wall-add-tile #wall-window-picker')");
      await capture(`add-open-${t}`);
    }
    // Reply status layout.
    await run("integration.route('status')"); await sleep(500);
    for (const t of ['dark', 'light']) {
      await theme(t); await sleep(200);
      await check(`stats on the line after the sleeping label (${t})`, "(()=>{const s=document.querySelector('[role=status]');const label=[...s.querySelectorAll('span')].find(x=>x.textContent.startsWith('Sleeping'));const total=[...s.querySelectorAll('span')].find(x=>x.textContent.includes('total tokens'));return label&&total&&total.getBoundingClientRect().top>label.getBoundingClientRect().bottom-2})()");
      await capture(`status-${t}`, { x: 0, y: 0, width: 600, height: 170 });
    }
    // Short motion strip: Add window opening from the composer button.
    await reset(); await theme('dark');
    const frames = path.join(dir, 'add-motion'); fs.mkdirSync(frames);
    for (let i = 0; i < 24; i++) {
      if (i === 4) await run(addClick);
      fs.writeFileSync(path.join(frames, String(i).padStart(3, '0') + '.png'), (await win.capturePage(undefined, { stayHidden: true })).toPNG());
      await sleep(60);
    }
    const encoded = require('node:child_process').spawnSync('ffmpeg', ['-y', '-framerate', '12', '-i', path.join(frames, '%03d.png'), '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(dir, 'add-motion.mp4')], { encoding: 'utf8', windowsHide: true });
    report.motion = encoded.status === 0 ? 'add-motion.mp4' : 'ffmpeg unavailable: ' + String(encoded.error || encoded.stderr).slice(0, 200);
    if (win.isFocused()) throw Error('Fixture focus invariant failed');
    report.background = { visible: win.isVisible(), focused: win.isFocused(), bounds: win.getBounds() };
    report.success = !report.errors.some(e => /focus/.test(e));
  } catch (error) {
    report.errors.push(String(error)); report.success = false;
  } finally {
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ dir, success: report.success, failed: report.checks.filter(c => !c.passed).map(c => c.name), errors: report.errors.slice(0, 8) }, null, 2));
    win.destroy(); app.exit(report.success ? 0 : 1);
  }
});
