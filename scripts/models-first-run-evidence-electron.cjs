// Hidden, non-focusable, off-screen window; capturePage with stayHidden. Never shown over the desktop.
const {app,BrowserWindow,session,screen}=require('electron');const fs=require('node:fs'),path=require('node:path');
const dir=process.env.NEKKO_EVIDENCE_DIR,kind=process.env.NEKKO_EVIDENCE_KIND,profile=fs.mkdtempSync(path.join(dir,'profile-'));app.setPath('userData',profile);app.setPath('sessionData',profile);
const report={kind,revision:process.env.NEKKO_EVIDENCE_REVISION,checks:[],errors:[],captures:[]};const sleep=ms=>new Promise(r=>setTimeout(r,ms));const H=900;
const scenarios=(process.env.NEKKO_EVIDENCE_SCENARIOS||'new,engine,downloading,ready,library').split(',');
app.whenReady().then(async()=>{session.defaultSession.webRequest.onBeforeRequest((r,done)=>done({cancel:!/^(file:|data:|blob:)/.test(r.url)}));session.defaultSession.setPermissionRequestHandler((w,p,d)=>d(false));session.defaultSession.setPermissionCheckHandler(()=>false);
const left=Math.min(...screen.getAllDisplays().map(d=>d.bounds.x));const win=new BrowserWindow({width:1280,height:H,useContentSize:true,show:false,focusable:false,skipTaskbar:true,x:left-5000,y:-3000,title:'Isolated models evidence',webPreferences:{contextIsolation:true,sandbox:true,backgroundThrottling:false}});win.on('focus',()=>report.errors.push('OS focus taken'));win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('console-message',e=>{if(e.level==='error')report.errors.push(e.message)});
const run=s=>win.webContents.executeJavaScript(s,true);
const stable=()=>run(`(async()=>{await document.fonts.ready;let last='',n=0;for(let i=0;i<180;i++){await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const x=JSON.stringify([innerWidth,innerHeight,document.body.innerText.length,[...document.querySelectorAll('button,h2,h3')].map(e=>{const r=e.getBoundingClientRect();return [r.x,r.y,r.width,r.height]})]);n=x===last?n+1:0;last=x;if(n>=6)return true}throw Error('unstable frames')})()`);
const resize=async width=>{win.setContentSize(width,H);for(let i=0;i<6;i++){await sleep(100);const v=await run("({w:innerWidth,h:innerHeight})");if(v.w===width&&v.h===H)return;const b=win.getBounds();win.setBounds({...b,width:b.width+width-v.w,height:b.height+H-v.h})}throw Error('viewport mismatch')};
const capture=async name=>{await stable();const image=await win.capturePage(undefined,{stayHidden:true,stayAwake:true});if(image.isEmpty())throw Error('empty capture');const file=path.join(dir,name+'.png');fs.writeFileSync(file,image.toPNG());report.captures.push({file,size:image.getSize()})};
const check=async(name,s)=>{try{report.checks.push({name,passed:!!await run(s)})}catch(e){report.checks.push({name,passed:false,error:String(e)})}};
try{for(const scenario of scenarios)for(const width of [1280,480]){await win.loadFile(path.join(dir,'index.html'),{query:{s:scenario}});await resize(width);await sleep(600);await stable();
const label=`${scenario}-${width}`;
// The whole scroll, not just the first screen: the point is how much a newcomer has to read.
const full=await run(`Math.max(...[...document.querySelectorAll('.models-content,.models-workspace')].map(e=>e.scrollHeight))`);
win.setContentSize(width,Math.min(Math.max(full,H),6000));await sleep(300);
await capture(`models-${kind}-${label}`);
report.checks.push({name:label+' height',passed:true,value:full});
await check(label+' no horizontal overflow',`document.documentElement.scrollWidth<=innerWidth+1`);}
report.background={focused:win.isFocused(),bounds:win.getBounds()};
}catch(e){report.errors.push(String(e));try{await capture('failure-debug')}catch{}}finally{fs.writeFileSync(path.join(dir,'status.json'),JSON.stringify(report,null,2));console.log(kind,JSON.stringify({checks:report.checks,errors:report.errors,captures:report.captures.length},null,2));win.destroy();app.exit(report.errors.length||report.checks.some(c=>!c.passed)?1:0)}});
