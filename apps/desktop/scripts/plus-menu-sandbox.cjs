const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
const version = process.env.NEKKO_TEST_REVISION ? 'before' : 'after';
const dir = path.join(out, version);
fs.mkdirSync(dir, { recursive: true });
app.setPath('userData', path.join(dir, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_wc, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1200, height: 900, show: false, x: -16000, y: -16000, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.on('console-message', e => console.log(e.message));
  const run = async s => { try { return await win.webContents.executeJavaScript(s, true); } catch(e) { console.error('Failed expression:',s); throw e; } };
  const checks = [];
  const check = async (name, s) => { if (!await run(s)) throw Error(name); checks.push(name); };
  const move = async (x, y) => { win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(x),y:Math.round(y)}); await sleep(80); };
  const open = async () => { await move(350,700); await sleep(300); const p = await run("(()=>{const r=document.querySelector('.agent-panel-plus').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()"); console.log('opener',p); await move(p.x+2,p.y+2); await move(p.x,p.y); await sleep(100); };
  const capture = async name => fs.writeFileSync(path.join(dir, name+'.png'), (await win.capturePage(undefined, {stayHidden:true})).toPNG());
  try {
    await win.loadFile(path.join(out, 'index.html')); win.showInactive(); await sleep(1000);
    await run("integration.route('workspace')"); await sleep(500);
    for (const theme of ['light','dark']) {
      for (const width of [1200,400]) {
        win.setContentSize(width,900); await run(`document.documentElement.dataset.theme='${theme}'`); await sleep(200); if(width===400) { await run("document.querySelector('[aria-label=\"Open agent list\"]')?.click()"); await sleep(200); }
        await move(10,600); await sleep(400); await open();
        await check('hover opens '+theme+width,"!!document.querySelector('[data-new-agent-menu]')");
        await capture(`menu-${theme}-${width}`);
        if (version==='after') {
          await check('exactly three choices',"(()=>{const b=[...document.querySelectorAll('[data-new-agent-menu] button')];return b.length===3&&b[0].textContent.includes('Agent')&&b[1].textContent==='Media gen'&&b[2].textContent==='Terminal'})()");
          const r = await run("(()=>{const r=document.querySelector('[data-new-agent-menu]').getBoundingClientRect();return {x:r.x+20,y:r.y+20}})()");
          await move(r.x,r.y); await sleep(300);
          await check('crossing gap retains menu',"!!document.querySelector('[data-new-agent-menu]')");
          await move(width-5,800); await sleep(300);
          await check('leaving list closes',"!document.querySelector('[data-new-agent-menu]')");
          await open(); await move(width-5,800); await sleep(300);
          await check('leaving button closes',"!document.querySelector('[data-new-agent-menu]')");
        }
      }
    }
    if(version==='after') {
      await open(); await run("[...document.querySelectorAll('[data-new-agent-menu] button')].find(b=>b.textContent==='Media gen').click()"); await sleep(350);
      await check('media entry configures image chat',"integration.calls.some(c=>c.method==='options'&&c.options.chatType==='image')");
      win.setContentSize(1200,900); await run('integration.reset()'); await run("integration.route('workspace')"); await sleep(400); await open();
      await run("[...document.querySelectorAll('[data-new-agent-menu] button')].find(b=>b.textContent==='Terminal').click()"); await sleep(400);
      await check('terminal delegates default shell to host',"integration.calls.some(c=>c.method==='terminal'&&!c.options.shell)");
    }
    if(version==='after') {
      await run('integration.reset()'); await run("integration.route('workspace')"); win.setContentSize(1200,900); await sleep(300); await open();
      const motion=path.join(dir,'motion'); fs.mkdirSync(motion,{recursive:true});
      for(let i=0;i<12;i++) {
        if(i===4) { const r=await run("(()=>{const r=document.querySelector('[data-new-agent-menu]').getBoundingClientRect();return {x:r.x+30,y:r.y+30}})()"); await move(r.x,r.y); }
        if(i===7) await move(600,600);
        fs.writeFileSync(path.join(motion,`frame-${String(i).padStart(2,'0')}.png`),(await win.capturePage(undefined,{stayHidden:true})).toPNG()); await sleep(100);
      }
    }
    win.setContentSize(1200,900); await run("integration.route('settings')"); await sleep(500);
    await run("document.querySelector('[aria-label=\"Terminal renderer\"]')?.closest('section').scrollIntoView()"); await sleep(400);
    await capture('settings-light');
    for(const theme of ['light','dark']) for(const width of [1200,400]) {
      win.setContentSize(width,900); await run(`document.documentElement.dataset.theme='${theme}'`); await sleep(200);
      await run("document.querySelector('[aria-label=\"Terminal renderer\"]')?.closest('section').scrollIntoView()"); await sleep(400); await capture(`settings-${theme}-${width}`);
    }
    if(version==='after') {
      await check('shell selection available only in settings',"document.querySelector('[aria-label=\"Default shell\"]')?.options.length===2");
      await run("(()=>{const s=document.querySelector('[aria-label=\"Default shell\"]');const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;set.call(s,'/bin/sh');s.dispatchEvent(new Event('change',{bubbles:true}));})()"); await sleep(300);
      await check('shell selection persists setting',"integration.calls.some(c=>c.method==='settings'&&c.patch.defaultShellPath==='/bin/sh')");
    }
    fs.writeFileSync(path.join(dir,'report.json'),JSON.stringify({checks},null,2));
    console.log(JSON.stringify({dir,checks}));
  } catch(e) { console.error(e); process.exitCode=1; }
  finally { win.destroy(); app.quit(); }
});
