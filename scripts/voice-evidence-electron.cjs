const {app,BrowserWindow,session,screen}=require('electron');const fs=require('node:fs'),path=require('node:path');
const dir=process.env.NEKKO_EVIDENCE_DIR,kind=process.env.NEKKO_EVIDENCE_KIND,profile=fs.mkdtempSync(path.join(dir,'profile-'));app.setPath('userData',profile);app.setPath('sessionData',profile);
const errors=[];const sleep=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{session.defaultSession.webRequest.onBeforeRequest((r,done)=>done({cancel:!/^(file:|data:|blob:)/.test(r.url)}));session.defaultSession.setPermissionRequestHandler((w,p,d)=>d(false));session.defaultSession.setPermissionCheckHandler(()=>false);
const left=Math.min(...screen.getAllDisplays().map(d=>d.bounds.x));const win=new BrowserWindow({width:600,height:420,useContentSize:true,show:false,focusable:false,skipTaskbar:true,x:left-5000,y:-3000,webPreferences:{contextIsolation:true,sandbox:true,backgroundThrottling:false}});win.on('focus',()=>errors.push('OS focus taken'));win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
const run=s=>win.webContents.executeJavaScript(s,true);
const settle=async()=>{await run('document.fonts.ready');for(let i=0;i<12;i++){await sleep(100);}};
const capture=async name=>{await settle();const image=await win.capturePage(undefined,{stayHidden:true,stayAwake:true});if(image.isEmpty())throw Error('empty capture');fs.writeFileSync(path.join(dir,name+'.png'),image.toPNG());};
try{await win.loadFile(path.join(dir,'index.html'));win.showInactive();await sleep(1500);
for(const theme of ['light','dark']){await run(`document.documentElement.dataset.theme='${theme}'`);await capture(`${kind}-${theme}-initial`);
// "Use" on the Apple row (after) or "Download & enable" (before): the one-click setup.
await run(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/^(Use|Download & enable)$/.test(x.textContent.trim()));b?.click()})()`);await capture(`${kind}-${theme}-enabled`);await run(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/^(Turn off)$/.test(x.textContent.trim()));b?.click()})()`);}
}catch(e){errors.push(String(e))}finally{fs.writeFileSync(path.join(dir,'status.json'),JSON.stringify({kind,errors,focused:win.isFocused(),bounds:win.getBounds()},null,2));console.log(kind,JSON.stringify(errors));win.destroy();app.exit(errors.length?1:0)}});
