// Isolated real-renderer feedback/settings journey. No host or external requests.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
app.disableHardwareAcceleration(); // capturePage throws UnknownVizError on GPU-less hosts otherwise
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], checks: [], errors: [] };
const js = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1280, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -6000, y: -6000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false, offscreen: true } });
  const run = s => win.webContents.executeJavaScript(s, true);
  // Entrance animations don't advance in a hidden window, so settle them before a still.
  const shot = async name => { await run('document.getAnimations().forEach(a => { try { a.finish(); } catch {} })'); await sleep(50); const f = path.join(out, name + '.png'); fs.writeFileSync(f, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(f); };
  win.on('focus', () => report.errors.push('took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 500)); });
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 80 && !(await run('!!window.layoutFixture')); i++) await sleep(150);
    await run(`localStorage.removeItem('nekko.support-star.thanked.nekko-supporter');localStorage.removeItem('nekko.support-star.thanked.motion-supporter');Object.assign(layoutFixture.bridge, {
      telemetryStatus: async()=>({configured:true}), getRemoteStatus: async()=>({enabled:false}),
      feedbackInfo: async()=>({app:'desktop',version:'0.8.2',os:'Windows'}),
      feedbackSend: async(...args)=>{if(window.failFeedback)throw Error('Fixture offline');window.feedbackSent=args;return {ok:true}},
      supportStarStatus: async()=>window.starState || {state:'not-starred',login:'nekko-supporter'},
      supportStar: async()=>{window.starWrites=(window.starWrites||0)+1; window.starState={state:'starred',login:'nekko-supporter'};return {...window.starState,newlyStarred:true}},
      openPath: async(url)=>{window.openedUrl=url}
    }); layoutFixture.store.setState({settings:{...layoutFixture.settings,guardrails:[],hooks:[],mcpServers:[],telemetry:{enabled:false},voice:{}}});
    layoutFixture.bridge.getSettings=async()=>layoutFixture.store.getState().settings;
    layoutFixture.store.getState().setView('settings');`);
    await sleep(900);
    await shot('settings-desktop');
    await run("window.dispatchEvent(new Event('nekko:feedback'))"); await sleep(200);
    await run("document.querySelector('[data-testid=feedback-kind-good]').click()"); await sleep(250);
    await shot('feedback-desktop');
    win.setContentSize(390, 844); await sleep(300); await shot('feedback-narrow');
    await run("document.querySelector('[aria-label=Close]').click()"); await sleep(200);
    await shot('settings-narrow');
    if (process.env.NEKKO_FEEDBACK_BASELINE !== '1') {
      const check = async (name, code) => { if (!(await run(code))) throw Error(name); report.checks.push(name); };
      await check('status reads never star', '!window.starWrites');
      await check('support group first', "document.querySelector('[data-settings-group]').dataset.settingsGroup === 'support'");
      await check('narrow viewport does not overflow', 'document.documentElement.scrollWidth <= innerWidth');
      win.setContentSize(1280, 900); await sleep(250);
      await run("document.querySelector('[data-testid=support-star-action]').click()"); await sleep(80);
      await check('explicit click writes exactly once and confirms selected state', "window.starWrites===1 && document.querySelector('[data-testid=support-star-action]').getAttribute('aria-pressed')==='true'");
      await check('first star celebrates', "!!document.querySelector('.support-star-celebrate')");
      fs.mkdirSync(path.join(out,'motion'),{recursive:true});
      for(let i=0;i<18;i++){fs.writeFileSync(path.join(out,'motion',String(i).padStart(3,'0')+'.png'),(await win.capturePage(undefined,{stayHidden:true})).toPNG());await sleep(65);}
      await sleep(300); await shot('settings-starred');
      await check('animation ends', "!document.querySelector('.support-star-celebrate')");
      await run("window.dispatchEvent(new Event('nekko:feedback'))"); await sleep(100);
      await run("document.querySelector('[data-testid=feedback-kind-good]').click()"); await sleep(180);
      await check('feedback shares confirmed star without replay', "document.querySelector('[role=dialog] [data-testid=support-star-action]').getAttribute('aria-pressed')==='true' && !document.querySelector('.support-star-celebrate') && window.starWrites===1");
      await shot('feedback-starred');
      const fill = async (selector,value) => run("(()=>{const e=document.querySelector("+js(selector)+"); const proto=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto,'value').set.call(e,"+js(value)+");e.dispatchEvent(new Event('input',{bubbles:true}));})()");
      await fill('#feedback-summary','A thoughtful little helper'); await fill('#feedback-description','The project makes local work easier.');
      await fill('#feedback-name','Ada'); await fill('#feedback-contact-email','not-an-email');
      await run("document.querySelector('[data-testid=feedback-send]').click()"); await sleep(100);
      await check('invalid optional email is explained and focused', "document.activeElement.id==='feedback-contact-email' && document.querySelector('#feedback-contact-error').textContent.includes('valid email') && !window.feedbackSent");
      await fill('#feedback-contact-email','ada@example.com');
      await run("window.failFeedback=true;document.querySelector('[data-testid=feedback-send]').click()"); await sleep(120);
      await check('send failure retains the optional contact draft', "document.querySelector('#feedback-name').value==='Ada' && document.querySelector('#feedback-contact-email').value==='ada@example.com' && document.querySelector('[role=dialog]').textContent.includes('Fixture offline') && !window.feedbackSent");
      await run("window.failFeedback=false");
      await run("document.querySelector('[data-testid=feedback-send]').click()"); await sleep(150);
      await check('contact travels with note only; good sends no app info', "window.feedbackSent[0].includes('Name (optional): Ada') && window.feedbackSent[0].includes('ada@example.com') && window.feedbackSent[1]===false && window.feedbackSent[2].length===0");
      await shot('feedback-success');
      await run("document.querySelector('[aria-label=Close]').click()"); await sleep(80);
      await run("window.starState={state:'unavailable',reason:'Connect your GitHub account in Connectors to check or add a star here.'};window.dispatchEvent(new Event('focus'))"); await sleep(120);
      await check('unknown status is not selected', "document.querySelector('[data-testid=support-star-action]').getAttribute('aria-pressed')==='false'");
      await run("document.querySelector('[data-testid=support-star-action]').click()"); await sleep(80);
      await check('browser fallback does not claim success', "window.openedUrl==='https://github.com/nekko-labs/nekko-agent' && window.starWrites===1 && document.querySelector('[data-testid=support-star-action]').getAttribute('aria-pressed')==='false'");
      await shot('settings-unavailable');
      await win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
      await run("window.starState={state:'not-starred',login:'motion-supporter'};layoutFixture.bridge.supportStar=async()=>({state:'starred',login:'motion-supporter',newlyStarred:true});window.dispatchEvent(new Event('focus'))");await sleep(100);
      await run("document.querySelector('[data-testid=support-star-action]').click()");await sleep(80);
      await check('reduced motion disables thank-you animation', "getComputedStyle(document.querySelector('[data-testid=support-star-mascot]')).animationName==='none'");
      await shot('settings-reduced-motion');
      await win.webContents.debugger.detach();
    }

  } catch (e) { report.errors.push(String(e.stack || e)); process.exitCode = 1; }
  report.hidden = !win.isVisible(); report.focusable = win.isFocusable();
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(process.exitCode || (report.errors.length === 0 && report.captures.length >= 4 ? 0 : 1));
});
