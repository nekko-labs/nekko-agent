const {app,BrowserWindow,session,screen}=require('electron');
const fs=require('node:fs');const path=require('node:path');const cp=require('node:child_process');
const out=process.env.NEKKO_INTEGRATION_OUT;if(!out)throw Error('Use integration runner');
app.commandLine.appendSwitch('force-device-scale-factor','1');
const after=process.env.NEKKO_PHASE==='after';const profile=fs.mkdtempSync(path.join(out,'profile-'));app.setPath('userData',profile);app.setPath('sessionData',profile);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const report={phase:process.env.NEKKO_PHASE,revision:after?'working-tree':'1044834c',checks:[],errors:[],captures:[],blockedNetwork:[],visuallyInspected:false,nativeCapture:false};
 session.defaultSession.webRequest.onBeforeRequest((r,done)=>{const cancel=!/^(file:|data:|blob:)/.test(r.url);if(cancel)report.blockedNetwork.push(r.url);done({cancel});});
 session.defaultSession.setPermissionRequestHandler((_w,_p,done)=>done(false));session.defaultSession.setPermissionCheckHandler(()=>false);
 const displays=screen.getAllDisplays().map(d=>d.bounds);
 const win=new BrowserWindow({width:1200,height:900,useContentSize:true,show:false,focusable:false,skipTaskbar:true,x:Math.min(...displays.map(d=>d.x))-4000,y:Math.min(...displays.map(d=>d.y))-3000,title:'Isolated background panels fixture',webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}});
 win.on('focus',()=>report.errors.push('Fixture took OS focus'));win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',e=>e.preventDefault());win.webContents.on('console-message',e=>{if(e.level==='error')report.errors.push(e.message);});
 const run=s=>win.webContents.executeJavaScript(s,true);
 const check=async(name,s)=>report.checks.push({name,passed:!!await run(s)});
 const capture=async name=>{await sleep(250);const viewport=await run('({x:0,y:0,width:innerWidth,height:innerHeight})');const image=await win.capturePage(viewport,{stayHidden:true,stayAwake:false});if(image.isEmpty())throw Error('Empty image');const file=path.join(out,name+'.png');fs.writeFileSync(file,image.toPNG());report.captures.push({file,size:image.getSize()});};
 const click=async s=>{await run(s);await sleep(200);};
 const reset=async theme=>{await run(`integration.reset();integration.state().settings.theme='${theme}';document.documentElement.dataset.theme='${theme}'`);await sleep(600);};
 const open=()=>click("(()=>{const b=document.querySelector('[data-wall-add-button]');b.focus({preventScroll:true});b.click()})()");
 try{
  await win.loadFile(path.join(out,'index.html'));win.showInactive();await sleep(1000);
  for(const width of [1200,400])for(const theme of ['light','dark']){
   win.setContentSize(width,900);if(!win.webContents.debugger.isAttached())win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});const label=`${width}-${theme}`;await reset(theme);await capture(label+'-toolbar-closed');
   const paneBefore=await run("document.querySelector('.command-wall-pane-stage')?.getBoundingClientRect().toJSON()");
   await open();await capture(label+'-toolbar-open');
   if(after){
    await check(label+' dropdown portalled and bounded',"(()=>{const e=document.querySelector('.agent-window-dropdown');const r=e?.getBoundingClientRect();return e?.parentElement===document.body&&r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()");
    await check(label+' dropdown does not resize wall',`JSON.stringify(document.querySelector('.command-wall-pane-stage')?.getBoundingClientRect().toJSON())===${JSON.stringify(JSON.stringify(paneBefore))}`);
   }
   await click("[...document.querySelectorAll('.agent-window-picker__option')].find(b=>b.querySelector('strong')?.textContent==='Chat').click()");await capture(label+'-toolbar-chat');
   if(after){await click("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");await check(label+' Escape closes and restores DOM focus',"!document.querySelector('.agent-window-dropdown')&&document.activeElement===document.querySelector('[data-wall-add-button]')");await open();await click("document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))");await check(label+' outside pointer dismisses',"!document.querySelector('.agent-window-dropdown')");}
   await reset(theme);await run('integration.dashboard()');await sleep(900);
   await run("document.querySelector('[aria-label=\"Budget monitor\"]').scrollIntoView({block:'start'})");
   for(const range of ['1m','today','all-time']){
    await click(`[...document.querySelectorAll('[aria-label="Budget time range"] button')].find(b=>b.textContent==='${range}').click()`);
    await capture(label+'-budget-'+range);
    await check(label+' '+range+' sole active range',`[...document.querySelectorAll('[aria-label="Budget time range"] button')].filter(b=>b.getAttribute('aria-pressed')==='true').map(b=>b.textContent).join()==='${range}'`);
    if(after){const spend=range==='today'?'$0.42':range==='1m'?'$2.32':'$9.82';const local=range==='today'?'1,500':range==='1m'?'5,500':'15,500';await check(label+' '+range+' detail follows range',`(()=>{const t=document.querySelector('[aria-label="Budget monitor"]').innerText;return t.includes('${spend}')&&t.includes('${local}')&&!t.includes('Unavailable')})()`);}
   }
   await reset(theme);await run("integration.route('settings')");await sleep(800);
   await run("(()=>{const text=[...document.querySelectorAll('span')].find(e=>e.textContent==='Desktop notifications');text.closest('section').scrollIntoView({block:'start'})})()");await capture(label+'-notifications-on');
   if(after){await check(label+' standalone Notifications',"!!document.querySelector('#notifications [aria-label=\"Desktop notifications\"][aria-checked=true]')");await click("document.querySelector('#notifications [role=switch]').click()");await check(label+' disable persists only notification setting',"integration.calls.some(c=>c.method==='settings'&&JSON.stringify(c.patch)==='{'+'\"desktopNotifications\":false}')&&document.querySelector('#notifications [role=switch]').getAttribute('aria-checked')==='false'");await capture(label+'-notifications-off');await click("document.querySelector('#notifications [role=switch]').click()");await check(label+' enable persists',"integration.state().settings.desktopNotifications===true");}
  }
  win.setContentSize(1200,900);await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width:1200,height:900,deviceScaleFactor:1,mobile:false});await reset('light');const frames=path.join(out,'dropdown-frames');fs.mkdirSync(frames,{recursive:true});const times=[];const start=Date.now();let opened=false,closed=false;
  while(Date.now()-start<2000){const t=Date.now()-start;if(t>=300&&!opened){await open();opened=true;}if(t>=1200&&!closed){await click("document.querySelector('[data-wall-add-button]').click()");closed=true;}times.push(Date.now()-start);fs.writeFileSync(path.join(frames,`${times.length}.png`),(await win.capturePage(undefined,{stayHidden:true,stayAwake:false})).toPNG());await sleep(60);}
  fs.writeFileSync(path.join(frames,'frames.txt'),times.map((t,i)=>`file '${i+1}.png'\nduration ${((times[i+1]??2000)-t)/1000}`).join('\n')+`\nfile '${times.length}.png'\n`);
  cp.execFileSync('ffmpeg',['-y','-f','concat','-safe','0','-i',path.join(frames,'frames.txt'),'-vf','fps=15,pad=ceil(iw/2)*2:ceil(ih/2)*2','-c:v','libx264','-pix_fmt','yuv420p',path.join(out,'dropdown-motion.mp4')],{windowsHide:true,stdio:'pipe'});report.motion={file:path.join(out,'dropdown-motion.mp4'),timestampsMs:times};
  report.background={bounds:win.getBounds(),focused:win.isFocused(),focusable:win.isFocusable(),displays};const b=win.getBounds();report.background.offscreen=!displays.some(d=>b.x<d.x+d.width&&b.x+b.width>d.x&&b.y<d.y+d.height&&b.y+b.height>d.y);if(win.isFocused()||win.isFocusable()||!report.background.offscreen)report.errors.push('Background invariant failed');
 }catch(e){report.errors.push(String(e));}
 finally{report.success=!report.errors.length&&report.checks.every(c=>c.passed);win.destroy();fs.writeFileSync(path.join(out,'status.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({phase:report.phase,success:report.success,checks:report.checks.length,failed:report.checks.filter(c=>!c.passed),errors:report.errors,captures:report.captures.length}));app.exit(report.success?0:1);}
});
