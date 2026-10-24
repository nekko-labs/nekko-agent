const { app, BrowserWindow, protocol, session } = require('electron');
const fs = require('node:fs'); const path = require('node:path');
const out = process.argv[2];
protocol.registerSchemesAsPrivileged([{ scheme: 'fixture', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.setPath('userData', path.join(out, 'profile')); app.commandLine.appendSwitch('disable-background-networking');
app.on('window-all-closed', () => {});
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
 protocol.handle('fixture', r => { const u = new URL(r.url); const f = path.resolve(out, u.hostname, 'dist', '.' + u.pathname); if (!f.startsWith(out + path.sep)) return new Response('', { status: 403 }); return new Response(fs.readFileSync(f), { headers: { 'Content-Type': f.endsWith('.js') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : 'text/html' } }); });
 session.defaultSession.webRequest.onBeforeRequest((d, cb) => cb({ cancel: /^(https?|wss?):/.test(d.url) }));
 session.defaultSession.setPermissionRequestHandler((_w, _p, cb) => cb(false));
 const results = [];
 for (const width of [1000, 390]) for (const theme of ['dark', 'light']) for (const version of ['baseline', 'after']) {
  const win = new BrowserWindow({ width, height: 760, useContentSize: true, frame: false, show: false, focusable: false, x: -30000, y: -30000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const wc = win.webContents; wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  await win.loadURL(`fixture://${version}/index.html`); await wc.executeJavaScript(`document.documentElement.dataset.theme='${theme}'`); await sleep(350);
  const measured = await wc.executeJavaScript('({w:innerWidth,h:innerHeight})'); const b = win.getBounds(); win.setBounds({ ...b, width:b.width+width-measured.w,height:b.height+760-measured.h }); await sleep(100);
  const name = `${version}-${width}-${theme}`;
  const checks = await wc.executeJavaScript(`(() => { const q=document.querySelector('[data-agent-question]'), s=document.querySelector('[data-transcript-scroll]'); const nested=getComputedStyle(q).overflowY==='auto'; const old=s.scrollTop; s.scrollTop=0; const top=q.getBoundingClientRect().top; s.scrollTop=s.scrollHeight; const bottom=q.getBoundingClientRect().top; return { sharedScroll:s.contains(q), nested, movesWithConversation:top!==bottom, width:innerWidth, height:innerHeight, noHorizontalOverflow:document.documentElement.scrollWidth<=innerWidth, icon:!!document.querySelector('[data-pixel-question]') }; })()`);
  await sleep(100); fs.writeFileSync(path.join(out, name+'.png'), (await wc.capturePage(undefined,{stayHidden:true})).toPNG());
  if (version==='after') {
   await wc.executeJavaScript(`document.querySelector('[role=radio]').click()`); await sleep(50); await wc.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Next').click()`); await sleep(80);
   const next = await wc.executeJavaScript(`document.body.textContent.includes('Which themes should I verify?')`);
   await wc.executeJavaScript(`[...document.querySelectorAll('[role=checkbox]')].forEach(b=>b.click()); [...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Send answers').click()`); await sleep(80);
   checks.next=next; checks.submitted=await wc.executeJavaScript(`!!document.querySelector('[data-answer]')`);
  }
  results.push({ name, ...checks, hidden:!win.isVisible(), focusable:win.isFocusable() }); win.destroy();
 }
 // Record actual renderer frames while opening, scrolling and answering.
 const motion = new BrowserWindow({ width: 1000, height: 760, useContentSize:true, frame:false, show:false, focusable:false, x:-30000,y:-30000, webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false} });
 await motion.loadURL('fixture://after/index.html?motion');
 await motion.webContents.executeJavaScript("document.documentElement.dataset.theme='dark'"); await sleep(200);
 const frames=path.join(out,'motion'); fs.mkdirSync(frames,{recursive:true});
 for(let i=0;i<60;i++) {
  if(i===5) await motion.webContents.executeJavaScript('window.fixture.open()');
  if(i>=18&&i<34) await motion.webContents.executeJavaScript("document.querySelector('[data-transcript-scroll]').scrollTop -= 18");
  if(i>=34&&i<50) await motion.webContents.executeJavaScript("document.querySelector('[data-transcript-scroll]').scrollTop += 18");
  if(i===50) await motion.webContents.executeJavaScript("document.querySelector('[role=radio]').click()");
  fs.writeFileSync(path.join(frames,String(i).padStart(3,'0')+'.jpg'),(await motion.webContents.capturePage(undefined,{stayHidden:true})).toJPEG(85)); await sleep(50);
 }
 motion.destroy();
 fs.writeFileSync(path.join(out,'assertions.json'),JSON.stringify(results,null,2)); console.log(results);
 fs.writeFileSync(path.join(out,'gallery.html'), '<style>body{background:#ddd;font:16px sans-serif}main{display:grid;grid-template-columns:1fr 1fr}img{max-width:100%}</style><main>'+results.map(r=>`<figure><figcaption>${r.name}</figcaption><img src="${r.name}.png"></figure>`).join('')+'</main>');
 app.exit(results.filter(r=>r.name.startsWith('after')).every(r=>r.sharedScroll&&!r.nested&&r.movesWithConversation&&r.noHorizontalOverflow&&r.icon&&r.next&&r.submitted&&r.hidden&&!r.focusable)?0:1);
}).catch(e=>{console.error(e);app.exit(1)});
