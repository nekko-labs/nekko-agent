const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const dir = process.env.NEKKO_EVIDENCE_DIR, kind = process.env.NEKKO_EVIDENCE_KIND;
app.commandLine.appendSwitch('force-device-scale-factor', '1');
const profile = fs.mkdtempSync(path.join(dir, 'profile-')); app.setPath('userData', profile); app.setPath('sessionData', profile);
const report = { kind, checks: [], errors: [], captures: [], motion: [], visuallyInspected: false, limitations: ['No image-viewing tool available in this session; human pixel and motion review required', 'Actual App nav markup extracted, not full App lifecycle', 'Pane bodies and host mocked; no native chrome or OS focus-permission verification'] };
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((r, done) => done({ cancel: !/^(file:|data:|blob:)/.test(r.url) }));
  session.defaultSession.setPermissionRequestHandler((w,p,d)=>d(false)); session.defaultSession.setPermissionCheckHandler(()=>false);
  const left = Math.min(...screen.getAllDisplays().map(d=>d.bounds.x));
  const win = new BrowserWindow({ width:1440,height:900,useContentSize:true,show:false,focusable:false,skipTaskbar:true,x:left-5000,y:-3000,title:'Isolated board rail evidence',webPreferences:{contextIsolation:true,sandbox:true,backgroundThrottling:false} });
  win.on('focus',()=>report.errors.push('Unexpected OS focus')); win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('console-message', e=> {if(e.level==='error') report.errors.push(e.message);});
  const run = s => win.webContents.executeJavaScript(s,true);
  const check = async(name,code)=>report.checks.push({name,passed:!!await run(code)});
  const stable = async()=>{await run('document.fonts.ready');await sleep(450);};
  const metrics = ()=>run(`(()=>{const rect=e=>{if(!e)return null;const r=e.getBoundingClientRect(),s=getComputedStyle(e),a=getComputedStyle(e,'::after'),b=getComputedStyle(e,'::before');return {class:e.className,label:e.getAttribute('aria-label'),x:r.x,y:r.y,width:r.width,height:r.height,display:s.display,gap:s.gap,padding:[s.paddingTop,s.paddingRight,s.paddingBottom,s.paddingLeft],after:{top:a.top,bottom:a.bottom,left:a.left,right:a.right,width:a.width,height:a.height,background:a.backgroundColor},before:{top:b.top,bottom:b.bottom,left:b.left,right:b.right,width:b.width,height:b.height,background:b.backgroundColor}}};return {viewport:[innerWidth,innerHeight],theme:document.documentElement.dataset.theme,rail:rect(document.querySelector('.rail')),page:rect(document.querySelector('main>div')),stage:rect(document.querySelector('.command-wall-stage')),separators:[...document.querySelectorAll('[role=separator]')].map(rect),active:document.activeElement?.getAttribute('aria-label'),panes:document.querySelectorAll('[data-fixture-pane]').length}})()`);
  const capture = async name=>{await stable();const img=await win.capturePage(undefined,{stayHidden:true,stayAwake:true});if(img.isEmpty())throw Error('Empty capture');fs.writeFileSync(path.join(dir,name+'.png'),img.toPNG());report.captures.push({name,size:img.getSize(),metrics:await metrics()});};
  win.webContents.debugger.attach('1.3');
  const cdp=(method,params={})=>win.webContents.debugger.sendCommand(method,params);
  const move=async(x,y)=>{await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});};
  const key=async(key)=>{await cdp('Input.dispatchKeyEvent',{type:'keyDown',key,code:key,windowsVirtualKeyCode:{ArrowUp:38,ArrowDown:40,ArrowRight:39,ArrowLeft:37,Home:36,Tab:9}[key]});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key,code:key});await sleep(150);};
  const configure=async(width,theme)=>{
    win.setContentSize(width,900);
    for(let i=0;i<8;i++){await sleep(100);const v=await run('({w:innerWidth,h:innerHeight})');if(v.w===width&&v.h===900)break;const b=win.getBounds();win.setBounds({...b,width:b.width+width-v.w,height:b.height+900-v.h});}
    await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.activeElement?.blur();evidence.reset()`);await move(width-10,10);await stable();
  };
  try {
    await win.loadFile(path.join(dir,'index.html'));win.showInactive();await sleep(1000);await stable();
    for(const width of [1440,390])for(const theme of ['light','dark']) {
      await configure(width,theme); const label=`${width}-${theme}`;
      await check(label+' exact viewport',`innerWidth===${width}&&innerHeight===900`);
      await check(label+' real board mounted',`!!document.querySelector('.command-wall-stage')&&!!document.querySelector('.wall-composer-split')`);
      await capture(label+'-idle');
      if(process.env.NEKKO_EVIDENCE_HOLD && label==='1440-dark') { console.log('HOLD '+kind); await sleep(90000); }
      if(width>=768){
        const rest=await run(`document.querySelector('.rail').getBoundingClientRect().width`);
        await move(25,80);await capture(label+'-nav-hover');
        await check(label+' hover expands rail',`document.querySelector('.rail').getBoundingClientRect().width>${rest}+40`);
        await move(width-10,10);await run(`document.querySelector('.nav-item').focus()`);await key('Tab');await capture(label+'-nav-focus');
        await check(label+' keyboard nav focus retained',`document.activeElement.classList.contains('nav-item')`);
      } else await check(label+' desktop nav hidden',`getComputedStyle(document.querySelector('.rail').parentElement).display==='none'`);
      await run(`document.activeElement?.blur();document.querySelector('.wall-composer-side[data-edge="right"]').focus()`);
      const before=await run(`document.querySelector('.wall-composer').getBoundingClientRect().width`);
      await key('ArrowLeft');await stable();
      const after=await run(`document.querySelector('.wall-composer').getBoundingClientRect().width`);
      report.checks.push({name:label+' composer keyboard width resize changes size',passed:Math.abs(after-before)>1,before,after});
      await capture(label+'-resize-focus');await key('Home');
    }
    await configure(1440,'dark');
    const frames=path.join(dir,'motion');fs.mkdirSync(frames,{recursive:true});const start=Date.now();
    const listener=(_e,method,p)=>{if(method!=='Page.screencastFrame')return;const i=report.motion.length;fs.writeFileSync(path.join(frames,String(i).padStart(4,'0')+'.png'),Buffer.from(p.data,'base64'));report.motion.push({frame:i,elapsedMs:Date.now()-start,timestamp:p.metadata.timestamp});void cdp('Page.screencastFrameAck',{sessionId:p.sessionId});};
    win.webContents.debugger.on('message',listener);
    // Off-screen mapping is permitted for timing when hidden windows suppress animation frames.
    win.showInactive();
    await cdp('Page.startScreencast',{format:'png',everyNthFrame:1});
    await sleep(500);await move(25,80);await sleep(1000);await move(1420,10);await sleep(1000);await move(25,180);await sleep(1000);await move(1420,10);await sleep(500);
    await cdp('Page.stopScreencast');win.hide();win.webContents.debugger.removeListener('message',listener);
    if(report.motion.length<2)throw Error('CDP screencast yielded fewer than two frames');
    fs.writeFileSync(path.join(frames,'frames.txt'),report.motion.map((t,i)=>`file '${String(i).padStart(4,'0')}.png'\nduration ${Math.max(.016,((report.motion[i+1]?.elapsedMs??t.elapsedMs+100)-t.elapsedMs)/1000)}`).join('\n')+`\nfile '${String(report.motion.length-1).padStart(4,'0')}.png'\n`);
    cp.execFileSync('ffmpeg',['-y','-f','concat','-safe','0','-i',path.join(frames,'frames.txt'),'-vsync','vfr','-vf','pad=ceil(iw/2)*2:ceil(ih/2)*2','-pix_fmt','yuv420p',path.join(dir,'nav-hover.mp4')],{windowsHide:true,stdio:'pipe'});
    report.background={focused:win.isFocused(),visible:win.isVisible(),focusable:win.isFocusable(),bounds:win.getBounds(),profile};
  }catch(e){report.errors.push(String(e));try{report.debug=await run('document.body.innerText');await capture('failure-debug');}catch(_){}}
  finally{fs.writeFileSync(path.join(dir,'status.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({kind,captures:report.captures.length,frames:report.motion.length,failed:report.checks.filter(c=>!c.passed),errors:report.errors},null,2));win.destroy();app.exit(report.errors.length||report.checks.some(c=>!c.passed)?1:0);}
});
