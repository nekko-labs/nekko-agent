const {app,BrowserWindow,session}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const dir=process.env.NEKKO_STACK_FIXTURE_DIR,kind=process.env.NEKKO_STACK_FIXTURE_KIND;
if(!dir)throw Error('Use pr-stacks-integration.cjs');
app.setPath('userData',path.join(dir,'profile'));app.setPath('sessionData',path.join(dir,'profile'));
app.commandLine.appendSwitch('disable-background-networking');
const report={kind,checks:[],errors:[],captures:[],visuallyInspected:false};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
  session.defaultSession.webRequest.onBeforeRequest((d,done)=>done({cancel:! /^(file:|data:|blob:)/.test(d.url)}));
  session.defaultSession.setPermissionRequestHandler((_w,_p,done)=>done(false));
  const win=new BrowserWindow({width:1200,height:850,useContentSize:true,show:false,focusable:false,skipTaskbar:true,x:-10000,y:-10000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  win.on('focus',()=>report.errors.push('Unexpected OS focus'));
  win.webContents.on('console-message',e=>{if(e.level==='error')report.errors.push(e.message)});
  const run=code=>win.webContents.executeJavaScript(code,true);
  const check=(name,value)=>{report.checks.push({name,passed:!!value});if(!value)throw Error(name);};
  const click=async label=>{await run(`(()=>{const b=[...document.querySelectorAll('[data-pr-action-controls] button')].find(b=>b.textContent===${JSON.stringify(label)});if(!b)throw Error('Missing action');b.click()})()`);await sleep(250);};
  const shot=async name=>{await sleep(100);const file=path.join(dir,name+'.png');fs.writeFileSync(file,(await win.capturePage(undefined,{stayHidden:true,stayAwake:false})).toPNG());report.captures.push(file);};
  try {
    await win.loadFile(path.join(dir,'index.html'));win.setPosition(-10000,-10000);win.showInactive();await sleep(1000);
    await run("window.setFixturePrState('open')");
    for(const theme of ['dark','light'])for(const width of [1200,390]) {
      win.setContentSize(width,850);await run(`document.documentElement.dataset.theme='${theme}'`);await sleep(200);
      await shot(`${theme}-${width}-open`);
      const geometry=await run(`(()=>{const footer=document.querySelector('[aria-label="Chat actions and information"]');const buttons=[...footer.querySelectorAll('[data-pr-action-controls] button')].filter(b=>!b.closest('[inert]'));const overflow=buttons.filter(b=>{const r=b.getBoundingClientRect();return r.left<0||r.right>innerWidth||r.bottom>innerHeight});return {overflow:overflow.map(b=>b.textContent),continuations:buttons.filter(b=>b.textContent==='Continue as stacked PR').length}})()`);
      if(kind==='after') check(`${theme}/${width} controls fit viewport`,geometry.overflow.length===0);
      else report.checks.push({name:`${theme}/${width} baseline overflow`,controls:geometry.overflow});
      check(`${theme}/${width} continuation availability`,geometry.continuations===(kind==='after'?2:0));
    }
    if(kind==='after') {
      win.setContentSize(1200,850);await run("document.documentElement.dataset.theme='dark'");
      await run('window.stackFailure=true');await click('Continue as stacked PR');
      check('failure preserves active chat',await run("window.integration.state().activeSessionId===null && window.integration.records().length===1"));
      check('failure restores enabled action',await run("[...document.querySelectorAll('button')].some(b=>b.textContent==='Continue as stacked PR'&&!b.disabled)"));
      await run('window.stackFailure=false');await click('Continue as stacked PR');
      check('continuation opens and stores parent',await run("window.integration.state().activeSessionId.startsWith('followup-') && window.integration.records().at(-1).gitStackParent.url.endsWith('/401')"));
      await run('window.integration.reset()');await sleep(200);await run('window.stackFixture.parent()');await sleep(150);
      for(const theme of ['dark','light'])for(const width of [1200,390]) {
        win.setContentSize(width,850);await run(`document.documentElement.dataset.theme='${theme}'`);await shot(`${theme}-${width}-dependent`);
      }
      await click('Link stack');
      check('successful link forces the cached PR read',await run("window.integration.calls.some(c=>c.method==='listPrs'&&c.force===true)"));
      check('native linking updates live controls',await run("window.integration.calls.some(c=>c.method==='linkStack') && [...document.querySelectorAll('button')].some(b=>b.textContent==='Merge on GitHub') && ![...document.querySelectorAll('button')].some(b=>b.textContent==='Link stack')"));
      await click('Merge on GitHub');
      check('stack merge opens GitHub without ordinary merge',await run("window.integration.calls.some(c=>c.method==='openPath') && !window.integration.calls.some(c=>c.method==='prAction'&&c.action==='merge')"));
      await shot('light-390-native-stack');
      for(const patch of [{offline:true},{offline:false,incognito:true},{incognito:false,executionMode:'sandbox'}]) {
        await run(`window.stackFixture.policy(${JSON.stringify(patch)})`);await sleep(100);
        check('privacy boundary '+JSON.stringify(patch),await run("![...document.querySelectorAll('button')].some(b=>b.textContent==='Continue as stacked PR'||b.textContent==='Link stack')"));
      }
    }
    check('background window remains outside desktop',!win.isFocused()&&win.getBounds().x===-10000&&win.getBounds().y===-10000);
  } catch(e) {report.errors.push(String(e));}
  report.success=!report.errors.length;fs.writeFileSync(path.join(dir,'status.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));win.destroy();app.exit(report.success?0:1);
});
