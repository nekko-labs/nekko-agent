// Hidden, non-focusable, off-screen window; capturePage with stayHidden. Never shown over the desktop.
const {app,BrowserWindow,session,screen}=require('electron');const fs=require('node:fs'),path=require('node:path');
const dir=process.env.NEKKO_EVIDENCE_DIR,kind=process.env.NEKKO_EVIDENCE_KIND,profile=fs.mkdtempSync(path.join(dir,'profile-'));app.setPath('userData',profile);app.setPath('sessionData',profile);
const report={kind,revision:process.env.NEKKO_EVIDENCE_REVISION,checks:[],errors:[],captures:[]};const sleep=ms=>new Promise(r=>setTimeout(r,ms));const H=760;
app.whenReady().then(async()=>{session.defaultSession.webRequest.onBeforeRequest((r,done)=>done({cancel:!/^(file:|data:|blob:)/.test(r.url)}));session.defaultSession.setPermissionRequestHandler((w,p,d)=>d(false));session.defaultSession.setPermissionCheckHandler(()=>false);
const left=Math.min(...screen.getAllDisplays().map(d=>d.bounds.x));const win=new BrowserWindow({width:1280,height:H,useContentSize:true,show:false,focusable:false,skipTaskbar:true,x:left-5000,y:-3000,title:'Isolated connections evidence',webPreferences:{contextIsolation:true,sandbox:true,backgroundThrottling:false}});win.on('focus',()=>report.errors.push('OS focus taken'));win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('console-message',e=>{if(e.level==='error')report.errors.push(e.message)});
const run=s=>win.webContents.executeJavaScript(s,true);
// JSON.stringify leaves <, >, / and U+2028/2029 raw; escape them before splicing into evaluated code.
const js=v=>JSON.stringify(v).replace(/[<>/\u2028\u2029]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
const stable=()=>run(`(async()=>{await document.fonts.ready;let last='',n=0;for(let i=0;i<180;i++){await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const x=JSON.stringify([document.documentElement.dataset.theme,innerWidth,innerHeight,scrollY,[...document.querySelectorAll('label,input,button')].map(e=>{const r=e.getBoundingClientRect();return [r.x,r.y,r.width,r.height]})]);n=x===last?n+1:0;last=x;if(n>=6)return true}throw Error('unstable frames')})()`);
const resize=async width=>{win.setContentSize(width,H);for(let i=0;i<6;i++){await sleep(100);const v=await run("({w:innerWidth,h:innerHeight})");if(v.w===width&&v.h===H)return;const b=win.getBounds();win.setBounds({...b,width:b.width+width-v.w,height:b.height+H-v.h})}throw Error('viewport mismatch')};
const capture=async name=>{await stable();await win.capturePage(undefined,{stayHidden:true,stayAwake:true});await stable();const image=await win.capturePage(undefined,{stayHidden:true,stayAwake:true});if(image.isEmpty())throw Error('empty capture');const file=path.join(dir,name+'.png');fs.writeFileSync(file,image.toPNG());report.captures.push({file,size:image.getSize()})};
const check=async(name,s)=>{try{report.checks.push({name,passed:!!await run(s)})}catch(e){report.checks.push({name,passed:false,error:String(e)})}};
try{await win.loadFile(path.join(dir,'index.html'));win.showInactive();await sleep(800);await stable();
const click=sel=>run(`(()=>{const e=document.querySelector(${js(sel)});if(!e)throw Error('missing '+${js(sel)});e.click();return true})()`);
const scrollTo=sel=>run(`document.querySelector(${js(sel)}).scrollIntoView({block:'start'})`);
for(const width of [1280,480])for(const theme of ['light','dark']){await resize(width);await run(`document.documentElement.dataset.theme='${theme}'`);await stable();const label=`${width}-${theme}`;
await check(label+' every connection has a row',`document.querySelectorAll('[data-connection]').length===25`);
await check(label+' MCP shows off',`document.querySelector('[data-connection=mcp] [role=switch]').getAttribute('aria-checked')==='false'`);
await check(label+' no horizontal overflow',`document.documentElement.scrollWidth<=innerWidth+1`);
await scrollTo('#connections');await capture(`connections-top-${label}`);
await click('[data-connection=cloud-sync] button[aria-expanded]');await sleep(300);
await check(label+' log lists the events',`document.querySelectorAll('[data-connection=cloud-sync] ol li').length===5`);
await scrollTo('[data-connection=cloud-sync]');await capture(`connections-log-${label}`);
await click('[data-connection=cloud-sync] button[aria-expanded]');
await scrollTo('[data-connection=api-server]');await capture(`connections-incoming-${label}`);
await click('#connections [role=switch][aria-label="All connections off"]');await sleep(300);
await check(label+' all off greys every row',`[...document.querySelectorAll('[data-connection] [role=switch]')].every(t=>t.disabled&&t.getAttribute('aria-checked')==='false')`);
await scrollTo('#connections');await capture(`connections-all-off-${label}`);
await click('#connections [role=switch][aria-label="All connections off"]');await sleep(200);}
report.background={focused:win.isFocused(),bounds:win.getBounds()};
}catch(e){report.errors.push(String(e));try{await capture('failure-debug')}catch{}}finally{fs.writeFileSync(path.join(dir,'status.json'),JSON.stringify(report,null,2));console.log(kind,JSON.stringify({checks:report.checks.length,failed:report.checks.filter(x=>!x.passed),errors:report.errors,captures:report.captures.length},null,2));win.destroy();app.exit(report.errors.length||report.checks.some(c=>!c.passed)?1:0)}});
