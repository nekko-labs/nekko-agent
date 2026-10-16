const {app,BrowserWindow,session,screen}=require('electron');const fs=require('node:fs'),path=require('node:path');
const dir=process.env.NEKKO_EVIDENCE_DIR,kind=process.env.NEKKO_EVIDENCE_KIND,profile=fs.mkdtempSync(path.join(dir,'profile-'));app.setPath('userData',profile);app.setPath('sessionData',profile);
const report={kind,checks:[],errors:[],captures:[]};const sleep=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{session.defaultSession.webRequest.onBeforeRequest((r,done)=>done({cancel:!/^(file:|data:|blob:)/.test(r.url)}));session.defaultSession.setPermissionRequestHandler((w,p,d)=>d(false));
const left=Math.min(...screen.getAllDisplays().map(d=>d.bounds.x));const win=new BrowserWindow({width:1280,height:820,useContentSize:true,show:false,focusable:false,skipTaskbar:true,x:left-5000,y:-3000,title:'Isolated tasks/focus evidence',webPreferences:{contextIsolation:true,sandbox:true,backgroundThrottling:false}});
win.webContents.on('console-message',e=>{if(e.level==='error')report.errors.push(e.message)});const run=s=>win.webContents.executeJavaScript(s,true);
const capture=async name=>{await sleep(500);await win.capturePage(undefined,{stayHidden:true,stayAwake:true});await sleep(150);const img=await win.capturePage(undefined,{stayHidden:true,stayAwake:true});const file=path.join(dir,name+'.png');fs.writeFileSync(file,img.toPNG());report.captures.push(file)};
const check=async(name,s)=>{try{report.checks.push({name,passed:!!await run(s)})}catch(e){report.checks.push({name,passed:false,error:String(e)})}};
try{await win.loadFile(path.join(dir,'index.html'));win.showInactive();await sleep(1500);
for(const theme of ['light','dark']){await run(`document.documentElement.dataset.theme='${theme}'`);await check(theme+' clean start shown',`!!document.querySelector('[data-clean-start]')`);await check(theme+' greeting shown',`!!document.querySelector('[data-clean-start-greeting]')`);await check(theme+' no header/footer',`!document.querySelector('[data-clean-start] [aria-label="Chat actions and information"]')`);await capture(`focus-new-chat-${theme}`);}
await run(`document.documentElement.dataset.theme='light'`);
// The first message lands: the window becomes the full chat.
await run(`(()=>{const s=evidence.state();const c=s.settings.commandWall;window.__swap=true})()`);
await run(`evidence.route('rail')`);await sleep(800);
for(const theme of ['light','dark']){await run(`document.documentElement.dataset.theme='${theme}'`);await check(theme+' tasks section',`!!document.querySelector('[data-monitor-tasks]')`);await check(theme+' tasks listed',`document.querySelector('[data-gallery-rail]').innerText.includes('ENG-142')`);await capture(`monitor-tasks-${theme}`);}
await check('tab switch to tasks file',`(async()=>{const tabs=document.querySelectorAll('[data-monitor-tasks] [role=tab]');if(tabs.length<2)return false;tabs[1].click();await new Promise(r=>setTimeout(r,300));return document.querySelector('[data-gallery-rail]').innerText.includes('Write the focus-mode spec')})()`);await capture('monitor-tasks-tasksfile');
}catch(e){report.errors.push(String(e));await capture('failure')}finally{fs.writeFileSync(path.join(dir,'status.json'),JSON.stringify(report,null,2));console.log(kind,JSON.stringify({checks:report.checks.map(c=>(c.passed?'ok ':'FAIL ')+c.name),errors:report.errors.slice(0,5)},null,1));win.destroy();app.exit(0)}});
