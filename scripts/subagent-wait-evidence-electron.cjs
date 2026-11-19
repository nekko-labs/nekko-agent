// Hidden, non-focusable, off-screen window; capturePage with stayHidden. Never shown over the desktop.
const {app,BrowserWindow,session,screen}=require('electron');const fs=require('node:fs'),path=require('node:path');
const dir=process.env.NEKKO_EVIDENCE_DIR,kind=process.env.NEKKO_EVIDENCE_KIND,profile=fs.mkdtempSync(path.join(dir,'profile-'));app.setPath('userData',profile);app.setPath('sessionData',profile);
const report={kind,revision:process.env.NEKKO_EVIDENCE_REVISION,checks:[],errors:[],captures:[]};const sleep=ms=>new Promise(r=>setTimeout(r,ms));const H=560;
app.whenReady().then(async()=>{session.defaultSession.webRequest.onBeforeRequest((r,done)=>done({cancel:!/^(file:|data:|blob:)/.test(r.url)}));session.defaultSession.setPermissionRequestHandler((w,p,d)=>d(false));session.defaultSession.setPermissionCheckHandler(()=>false);
const left=Math.min(...screen.getAllDisplays().map(d=>d.bounds.x));const win=new BrowserWindow({width:1100,height:H,useContentSize:true,show:false,focusable:false,skipTaskbar:true,x:left-5000,y:-3000,title:'Isolated sub-agent wait evidence',webPreferences:{contextIsolation:true,sandbox:true,backgroundThrottling:false}});win.on('focus',()=>report.errors.push('OS focus taken'));win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('console-message',e=>{if(e.level==='error')report.errors.push(e.message)});
const run=s=>win.webContents.executeJavaScript(s,true);
const stable=()=>run(`(async()=>{await document.fonts.ready;let last='',n=0;for(let i=0;i<180;i++){await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const x=JSON.stringify([document.documentElement.dataset.theme,innerWidth,innerHeight,document.body.innerText.length]);n=x===last?n+1:0;last=x;if(n>=6)return true}throw Error('unstable frames')})()`);
const capture=async name=>{await stable();await win.capturePage(undefined,{stayHidden:true,stayAwake:true});await stable();const image=await win.capturePage(undefined,{stayHidden:true,stayAwake:true});if(image.isEmpty())throw Error('empty capture');const file=path.join(dir,name+'.png');fs.writeFileSync(file,image.toPNG());report.captures.push({file,size:image.getSize()})};
const check=async(name,s)=>{try{report.checks.push({name,value:await run(s)})}catch(e){report.checks.push({name,error:String(e)})}};
try{await win.loadFile(path.join(dir,'index.html'));await sleep(800);await stable();
for(const theme of ['light','dark']){await run(`document.documentElement.dataset.theme='${theme}'`);await sleep(300);await stable();
await check(theme+' parent group',`(()=>{const row=document.querySelector('[data-archive-row="parent"]');let el=row;while(el&&!el.querySelector('h2,h3,[role=heading]'))el=el.parentElement;return el?(el.querySelector('h2,h3,[role=heading]')||{}).textContent:null})()`);
await check(theme+' footer',`document.querySelector('[data-footer]').innerText`);
await capture(`subagent-wait-${kind}-${theme}`);}
report.background={focused:win.isFocused(),bounds:win.getBounds()};
}catch(e){report.errors.push(String(e));try{await capture('failure-debug')}catch{}}finally{fs.writeFileSync(path.join(dir,'status.json'),JSON.stringify(report,null,2));console.log(kind,JSON.stringify({checks:report.checks,errors:report.errors,captures:report.captures.length},null,2));win.destroy();app.exit(report.errors.length?1:0)}});
