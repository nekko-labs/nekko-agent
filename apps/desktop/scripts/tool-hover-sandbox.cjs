const {app,BrowserWindow,session}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const out=process.env.NEKKO_INTEGRATION_OUT;
app.setPath('userData',path.join(out,'profile'));
app.whenReady().then(async()=>{
 session.defaultSession.webRequest.onBeforeRequest((d,cb)=>cb({cancel:! /^(file:|data:)/.test(d.url)}));
 const win=new BrowserWindow({width:900,height:650,show:false,focusable:false,webPreferences:{backgroundThrottling:false}});
 try {
 await win.loadFile(path.join(out,'index.html')); await new Promise(r=>setTimeout(r,600));
 const b=await win.webContents.executeJavaScript(`(()=>{const b=document.querySelector('ol button').getBoundingClientRect();return {x:b.x+80,y:b.y+b.height/2}})()`);
 win.webContents.sendInputEvent({type:'mouseMove',...b}); await new Promise(r=>setTimeout(r,700));
 fs.writeFileSync(path.join(out,'hover.png'),(await win.capturePage(undefined,{stayHidden:true})).toPNG());
 console.log(await win.webContents.executeJavaScript(`JSON.stringify({tooltip:document.querySelector('[role=tooltip]')?.textContent,bounds:document.querySelector('[role=tooltip]')?.getBoundingClientRect().toJSON()})`));
 }catch(e){console.error(e);process.exitCode=1;}finally{win.destroy();app.exit(process.exitCode||0)}
});
