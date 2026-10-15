const {app,BrowserWindow,session,screen}=require('electron');
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const out=process.env.NEKKO_SWITCH_OUT;
if(!out) throw Error('Use chat-switch-integration.cjs');
app.setPath('userData',path.join(out,'profile')); app.setPath('sessionData',path.join(out,'profile'));
const report={checks:[],captures:[],errors:[],visualInspection:false,nativeChromeVerified:false,source:process.env.NEKKO_SWITCH_SOURCE};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 session.defaultSession.webRequest.onBeforeRequest((d,done)=>done({cancel:!/^(file:|data:|blob:)/.test(d.url)}));
 session.defaultSession.setPermissionCheckHandler(()=>false);session.defaultSession.setPermissionRequestHandler((_w,_p,done)=>done(false));
 const bounds=screen.getAllDisplays().map(d=>d.bounds);
 const win=new BrowserWindow({width:1200,height:900,useContentSize:true,show:false,focusable:false,skipTaskbar:true,x:Math.min(...bounds.map(b=>b.x))-1500,y:Math.min(...bounds.map(b=>b.y))-1200,title:'Synthetic chat switch verification',webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 win.on('focus',()=>report.errors.push('OS focus acquired'));
 win.webContents.on('console-message', e=>{if(e.level==='error')console.error('renderer:',e.message);});
 const run=s=>win.webContents.executeJavaScript(s,true).catch(e=>{throw Error('Script: '+s+'\n'+e);});
 const check=async(name,expr)=>{if(!await run(expr))throw Error(name);report.checks.push(name);};
 const shot=async name=>{const file=path.join(out,name+'.png');fs.writeFileSync(file,(await win.capturePage(undefined,{stayHidden:true,stayAwake:false})).toPNG());report.captures.push(file);};
 const switchTo=async id=>{await run(`switchChat(${JSON.stringify(id)})`);await sleep(80);};
 try{
 await win.loadFile(path.join(out,'index.html'));win.showInactive();await sleep(800);
 await run("switchChat('blank');integration.route('lifecycle')");await sleep(500);
 await run('seedDrafts()');await switchTo('existing');await sleep(100);
 await check('mounted real editor','!!document.querySelector("[contenteditable=true],[contenteditable=plaintext-only]")');
 const value='Alpha last-keystroke';
 await run(`(()=>{const e=document.querySelector('[contenteditable]');e.textContent=${JSON.stringify(value)};e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'e'}));})()`);
 await sleep(30);
 await check('not persisted before debounce',`loadDraft('existing').text==='Alpha'`);
 await switchTo('other');
 await check('outgoing last keystroke flushed',`loadDraft('existing').text===${JSON.stringify(value)}`);
 await check('other draft restored without image leakage',`document.querySelector('[contenteditable]').textContent==='Beta' && [...document.querySelectorAll('img[alt^="Pending attachment"]')].length===1 && document.querySelector('img[alt^="Pending attachment"]').src===loadDraft('other').images[0]`);
 await switchTo('existing');
 await check('duplicate images and last keystroke restored',`document.querySelector('[contenteditable]').textContent===${JSON.stringify(value)} && [...document.querySelectorAll('img[alt^="Pending attachment"]')].length===2 && [...document.querySelectorAll('img[alt^="Pending attachment"]')].every(i=>i.src===loadDraft('existing').images[0])`);
 for(const theme of ['light','dark'])for(const width of [1200,400]){
 win.setContentSize(width,900);await run(`document.documentElement.dataset.theme='${theme}'`);await sleep(250);await shot(`existing-${theme}-${width}`);await switchTo('other');await shot(`other-${theme}-${width}`);await switchTo('existing');
 }
 win.setContentSize(1200,900);await run("document.documentElement.dataset.theme='light'");
 const motion=path.join(out,'motion');fs.mkdirSync(motion);
 for(let i=0;i<30;i++){if(i===6||i===18)await switchTo('other');if(i===12||i===24)await switchTo('existing');fs.writeFileSync(path.join(motion,`${String(i).padStart(3,'0')}.png`),(await win.capturePage(undefined,{stayHidden:true,stayAwake:false})).toPNG());await sleep(100);}
 const encoded=cp.spawnSync('ffmpeg',['-y','-framerate','10','-i',path.join(motion,'%03d.png'),'-vf','pad=ceil(iw/2)*2:ceil(ih/2)*2','-c:v','libx264','-pix_fmt','yuv420p',path.join(out,'switch-motion.mp4')],{windowsHide:true,encoding:'utf8'});if(encoded.status!==0)throw Error(encoded.error?.message||encoded.stderr);report.captures.push(path.join(out,'switch-motion.mp4'));
 await run("integration.route('command')");await sleep(500);
 await check('mounted CommandCenterView',"!!document.querySelector('[data-command-wall]')");
 const clickExisting=async()=>{await run("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Add window').click()");await sleep(100);await run("[...document.querySelectorAll('.agent-window-picker__option')].find(b=>b.querySelector('strong')?.textContent==='Chat').click()");await sleep(100);await run("[...document.querySelectorAll('.agent-window-picker button')].find(b=>b.textContent.includes('Existing conversation')).click()");await sleep(150);};
 await clickExisting();const count=await run("document.querySelectorAll('[data-grid-cell=\"chat:existing\"]').length");
 await clickExisting();
 await check('reselect does not duplicate wall pane',`document.querySelectorAll('[data-grid-cell="chat:existing"]').length===${count} && ${count}===1`);
 await shot('wall-reselect-light-1200');
 if(report.errors.length)throw Error(report.errors.join('; '));report.success=true;
 }catch(e){report.success=false;report.errors.push(String(e));console.error(e);}
 finally{fs.writeFileSync(path.join(out,'status.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({out,...report},null,2));win.destroy();app.exit(report.success?0:1);}
});
