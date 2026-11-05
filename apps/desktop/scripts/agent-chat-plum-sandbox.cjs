// Synthetic bridge only. Hidden, non-focusable, isolated profile, network denied.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Use agent-window-controls-integration.cjs');
const dir = path.join(out, 'plum');
fs.mkdirSync(dir, { recursive: true });
app.setPath('userData', path.join(dir, 'profile'));
app.setPath('sessionData', path.join(dir, 'profile'));
app.disableHardwareAcceleration();
const report = { checks: [], captures: [], errors: [] };
const base = !!process.env.NEKKO_TEST_REVISION;
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1400, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, title: 'Agent plum synthetic evidence', webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.webContents.on('console-message', e => { if(e.level === 'error') console.error('Fixture:', e.message); });
  const run = async s => { try { return await win.webContents.executeJavaScript(s, true); } catch(e) { throw Error('Fixture command failed: '+s+'\n'+String(e)); } };
  const shot = async () => (await win.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG();
  const capture = async name => { const file = path.join(dir, name + '.png'); fs.writeFileSync(file, await shot()); report.captures.push(file); };
  const check = (name, ok, facts) => { report.checks.push({ name, ok, facts }); if (!ok && !base) throw Error(name + ': ' + JSON.stringify(facts)); };
  const wall = mode => run(`(() => { const name='${mode}'==='focus'?'Focused':'Dynamic'; const b=[...document.querySelectorAll('.wall-layout-segments button')].find(b=>b.textContent.trim()===name);if(!b)throw Error('Missing '+name+' layout control');b.click();document.querySelector('[aria-label="Show the agent panel"]')?.click(); })()`);
  const theme = () => run("integration.theme({theme:'dark',themePreset:'x-plum-dark',defaultProviderId:'fixture',defaultModelId:'fixture-model'}); document.querySelector('[aria-label=\"Detailed: every control\"]')?.click(); document.documentElement.dataset.theme='dark'; document.documentElement.dataset.preset='x-plum-dark'; integration.records().forEach(s=>integration.state().setPlanRail(s.id,false))");
  const facts = () => run(`(() => {
    const windows = [...document.querySelectorAll('.command-wall-window')].filter(w => { const r=w.getBoundingClientRect(); return !w.hasAttribute('data-wall-parked') && r.width>0 && r.height>0 && r.left>=0 && r.top>=0 && r.left<innerWidth; });
    return windows.map(w => { const p=w.querySelector(':scope > .panel'), row=w.querySelector('[data-composer-suggestions-row]'), bar=w.querySelector('.composer-bar'), effort=w.querySelector('[data-effort-index]'); return {id:w.dataset.wallPane,selected:w.hasAttribute('data-wall-selected'),glow:p && +getComputedStyle(p).getPropertyValue('--nekko-glow'),animation:p && getComputedStyle(p,'::before').animationName,effortBorder:effort && getComputedStyle(effort).borderTopWidth,row:!!row,below:!!row && !!bar && row.getBoundingClientRect().top>=bar.getBoundingClientRect().bottom-1}; });
  })()`);
  try {
    await win.loadFile(path.join(out, 'index.html'), { query: { multi: '1' } });
    for(let i=0;i<150 && !await run('!!window.integration && !!document.querySelector(".command-wall-window")');i++) await sleep(100);
    await theme(); await wall('focus'); await sleep(800);
    await run("[...document.querySelectorAll('[data-agent-panel] .agent-chip')].find(c=>c.title==='Existing conversation').click()");
    await run(`(() => { const ed=document.querySelector('.command-wall-window[data-wall-selected] .composer [contenteditable], .command-wall-window[data-wall-selected] .composer textarea'); if(!ed) throw Error('Missing composer'); ed.focus(); if(ed.tagName==='TEXTAREA'){Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(ed,'Please improve this feature and explain the changes.');ed.dispatchEvent(new Event('input',{bubbles:true}));}else{document.execCommand('insertText',false,'Please improve this feature and explain the changes.');} })()`);
    for(let i=0;i<8;i++){await shot();await sleep(200);}
    await capture('full-chat-1400');
    const cards=await run("[...document.querySelectorAll('[data-agent-panel] .agent-chip')].map(c=>({bg:getComputedStyle(c).backgroundColor,border:getComputedStyle(c).borderTopWidth}))");
    check('flat sidebar chats',cards.length>0 && cards.every(c=>c.bg==='rgba(0, 0, 0, 0)' && c.border==='0px'),cards);
    let f=await facts(); check('full chat keeps selected glow',f.some(w=>w.selected && w.glow>.99),f);
    check('effort gauge is borderless',f.some(w=>w.effortBorder==='0px'),f);
    check('suggestions have next row',f.some(w=>w.row && w.below),f);
    win.setContentSize(460,900); await sleep(900); await capture('full-chat-460');
    f=await facts();check('narrow suggestions keep their own row',f.some(w=>w.selected && w.below),f);
    await run("document.querySelector('[data-prompt-suggestions]')?.click()");
    check('suggestions still open',await run("!!document.querySelector('[role=dialog][aria-label=\"Prompt suggestions\"]')"),{});
    await run("document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    win.setContentSize(1400,900); await wall('grid'); await sleep(2400); await capture('dynamic-1400');
    f=await facts();check('only active Dynamic pane glows',f.length>=2 && f.filter(w=>w.glow>.99).length===1 && f.filter(w=>!w.selected).every(w=>w.glow===0),f);
    const firstActive=f.find(w=>w.selected)?.id;
    await run("document.querySelectorAll('[data-agent-panel] .agent-chip')[1].click()");
    // Hidden windows need captured frames to advance CSS transitions.
    for(let i=0;i<8;i++){await shot();await sleep(200);}
    f=await facts();check('selection moves gradient to the next pane',f.some(w=>w.selected && w.id!==firstActive && w.glow>.99) && f.filter(w=>!w.selected).every(w=>w.glow<.01),f);
    await sleep(1000); await capture('dynamic-second-active-1400');
    await win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Animation.enable');
    await win.webContents.debugger.sendCommand('Animation.setPlaybackRate',{playbackRate:8});
    const frames=[], opacities=[];for(let i=0;i<24;i++){frames.push(await shot());opacities.push(await run("Number(getComputedStyle(document.querySelector('.command-wall-window[data-wall-selected] > .panel'),'::before').opacity)"));await sleep(160);}
    check('window color actually crossfades',Math.max(...opacities)-Math.min(...opacities)>.2,opacities);
    const gif=path.join(dir,'window-colour-transition.gif'); require('./evidence-gif.cjs')(gif,frames,16);report.captures.push(gif);
    await win.webContents.debugger.sendCommand('Animation.setPlaybackRate',{playbackRate:1});
    await run("(() => { const s=JSON.parse(JSON.stringify(integration.records()[0]));s.messages=[]; sessionStorage.setItem('fixture-record',JSON.stringify(s));integration.reset(); })()");
    // Reload clears the transcript cache as well as the synthetic record.
    await win.loadFile(path.join(out,'index.html'),{query:{multi:'1'}});
    for(let i=0;i<150 && !await run('!!window.integration && !!document.querySelector(".command-wall-window")');i++) await sleep(100);
    await theme();await wall('focus');await sleep(500);
    await run("(() => {const card=[...document.querySelectorAll('[data-agent-panel] .agent-chip')].find(c=>c.title==='Existing conversation');if(!card)throw Error('Missing empty chat row');card.click();})()");
    for(let i=0;i<8;i++){await shot();await sleep(200);}
    await capture('new-chat-1400');
    const clean=await run("({greeting:!!document.querySelector('.command-wall-window[data-wall-selected] [data-clean-start-greeting]'),session:document.querySelector('.command-wall-window[data-wall-selected] [data-session-id]')?.getAttribute('data-session-id')})");check('new chat gradient remains',clean.greeting && clean.session==='existing' && (await facts()).some(w=>w.selected && w.glow>.99),{clean,panes:await facts()});
    win.setContentSize(460,900);await sleep(800);await capture('new-chat-460');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    f=await facts();check('reduced motion stops color animation',f.every(w=>w.animation==='none'),f);
    check('never shown or focused',!win.isVisible() && !win.isFocused(),{});
  } catch(e) {report.errors.push(String(e.stack||e));}
  finally {fs.writeFileSync(path.join(dir,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({dir,...report},null,2));win.destroy();app.exit(report.errors.length?1:0);}
});
