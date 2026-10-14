const {app,BrowserWindow,session,screen}=require('electron');const fs=require('node:fs'),path=require('node:path');
const dir=process.env.NEKKO_EVIDENCE_DIR,kind=process.env.NEKKO_EVIDENCE_KIND,profile=fs.mkdtempSync(path.join(dir,'profile-'));app.setPath('userData',profile);app.setPath('sessionData',profile);
const report={kind,checks:[],errors:[],captures:[],limitations:['Hidden Electron renderer evidence; not native window chrome.','Synthetic accounts and limits; no live vendor sign-in.']};const sleep=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{session.defaultSession.webRequest.onBeforeRequest((r,done)=>done({cancel:!/^(file:|data:|blob:)/.test(r.url)}));session.defaultSession.setPermissionRequestHandler((w,p,d)=>d(false));
const left=Math.min(...screen.getAllDisplays().map(d=>d.bounds.x));const win=new BrowserWindow({width:900,height:640,useContentSize:true,show:false,focusable:false,skipTaskbar:true,x:left-5000,y:-3000,title:'Isolated account email evidence',webPreferences:{contextIsolation:true,sandbox:true,backgroundThrottling:false}});
win.on('focus',()=>report.errors.push('OS focus taken'));win.webContents.on('console-message',e=>{if(e.level==='error')report.errors.push(e.message)});
const run=s=>win.webContents.executeJavaScript(s,true);
const stable=()=>run(`(async()=>{await document.fonts.ready;let last='',n=0;for(let i=0;i<240;i++){await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const x=document.body.innerHTML.length+':'+document.body.innerText;n=x===last?n+1:0;last=x;if(n>=8)return true}throw Error('unstable')})()`);
const shot=async(name,selector)=>{await stable();const rect=await run(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.floor(r.x),y:Math.floor(r.y),width:Math.ceil(r.width),height:Math.ceil(r.height)}})()`);const img=await win.capturePage(rect,{stayHidden:true,stayAwake:true});if(img.isEmpty())throw Error('empty capture');const file=path.join(dir,name+'.png');fs.writeFileSync(file,img.toPNG());report.captures.push({file,rect})};
try{await win.loadFile(path.join(dir,'index.html'));win.showInactive();await sleep(800);
for(const theme of ['light','dark']){await run(`document.documentElement.dataset.theme='${theme}'`);await sleep(200);
 await shot(`picker-${theme}`,'[data-shot=picker]');await shot(`utilization-${theme}`,'[data-shot=utilization]');
 report.checks.push({name:theme+' emails rendered',value:await run(`document.querySelectorAll('[data-account-email]').length`)});}
// Narrow: the dock squeezed to 300px, long work email must truncate, not overflow.
await run(`document.documentElement.dataset.theme='light';document.querySelector('[data-shot=utilization]').style.width='300px'`);await shot('utilization-narrow-light','[data-shot=utilization]');
report.checks.push({name:'narrow no horizontal overflow',passed:await run(`[...document.querySelectorAll('.wall-dock__provider')].every(e=>e.scrollWidth<=e.clientWidth+1)`)});
report.checks.push({name:'never focused',passed:!win.isFocused()});
}catch(e){report.errors.push(String(e))}finally{fs.writeFileSync(path.join(dir,'status.json'),JSON.stringify(report,null,2));console.log(kind,JSON.stringify({checks:report.checks,errors:report.errors,captures:report.captures.length}));win.destroy();app.exit(report.errors.length?1:0)}});
