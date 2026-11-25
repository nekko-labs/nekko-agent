// Send feedback: the feedback_opened report and the name and email filled in
// from About you behind "Include my name and email" (#3322). Hidden, isolated
// renderer, no host input or network. Launch through layout-evidence-integration.cjs
// with NEKKO_LAYOUT_SANDBOX=feedback-consent-sandbox.cjs; NEKKO_FEEDBACK_BASELINE=1
// takes the same stills from a revision without the change.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.disableHardwareAcceleration(); // capturePage throws UnknownVizError on GPU-less hosts otherwise
app.setPath('userData', path.join(out, 'profile'));
const baseline = process.env.NEKKO_FEEDBACK_BASELINE === '1';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { baseline, captures: [], checks: [], errors: [] };
const js = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1280, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -6000, y: -6000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false, offscreen: true } });
  const run = s => win.webContents.executeJavaScript(s, true);
  const shot = async name => { await run('document.getAnimations().forEach(a => { try { a.finish(); } catch {} })'); await sleep(50); const f = path.join(out, name + '.png'); fs.writeFileSync(f, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(f); };
  const check = async (name, code) => { if (!(await run(code))) throw Error(name); report.checks.push(name); };
  const fill = (selector, value) => run("(()=>{const e=document.querySelector(" + js(selector) + "); const proto=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto,'value').set.call(e," + js(value) + ");e.dispatchEvent(new Event('input',{bubbles:true}));})()");
  win.on('focus', () => report.errors.push('took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 500) + (process.env.NEKKO_DEBUG ? " @" + e.lineNumber + " after " + report.checks.length + " checks" : "")); });
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 80 && !(await run('!!window.layoutFixture')); i++) await sleep(150);
    await run(`window.reports=[]; Object.assign(layoutFixture.bridge, {
      telemetryStatus: async()=>({configured:true}), getRemoteStatus: async()=>({enabled:false}),
      telemetryCapture: async(event, props)=>{window.reports.push({event, ...props}); return null},
      feedbackInfo: async()=>({app:'desktop',version:'0.10.1004',os:'macOS'}),
      feedbackSend: async(...args)=>{window.feedbackSent=args;return {ok:true}},
      supportStarStatus: async()=>({state:'not-starred',login:'nekko-supporter'}),
      openPath: async()=>{}
    }); layoutFixture.store.setState({settings:{...layoutFixture.settings,guardrails:[],hooks:[],mcpServers:[],telemetry:{enabled:true,installId:'fixture'},voice:{},userName:'Ada Lovelace',userEmail:'ada@example.com'}});
    layoutFixture.bridge.getSettings=async()=>layoutFixture.store.getState().settings; 0;`);
    await sleep(900);
    await run("document.querySelector('[data-testid=rail-feedback]').click()"); await sleep(250);
    if (!baseline) await check('opening from the rail reports feedback_opened with source rail', "window.reports.some(r => r.event==='feedback_opened' && r.source==='rail')");
    await run("document.querySelector('[data-testid=feedback-kind-improve]').click()"); await sleep(250);
    await shot('feedback-improve');
    await fill('#feedback-summary', 'The model picker forgets my choice'); await fill('#feedback-description', 'After a restart it goes back to the default model.');
    await sleep(100);
    await shot('feedback-filled');
    if (!baseline) {
      await check('name and email come from About you', "document.querySelector('#feedback-name').value==='Ada Lovelace' && document.querySelector('#feedback-contact-email').value==='ada@example.com'");
      await check('include switch starts on', "document.querySelector('[data-testid=feedback-include-contact] [role=switch]').getAttribute('aria-checked')==='true'");
      await run("document.querySelector('[data-testid=feedback-include-contact] [role=switch]').click()"); await sleep(120);
      await shot('feedback-contact-off');
      await run("document.querySelector('[data-testid=feedback-send]').click()"); await sleep(150);
      await check('switched off, the note carries neither name nor email', "!!window.feedbackSent && !window.feedbackSent[0].includes('Ada') && !window.feedbackSent[0].includes('ada@example.com')");
      await run("document.querySelector('[aria-label=Close]').click()"); await sleep(150);

      await run("window.feedbackSent=null; window.dispatchEvent(new CustomEvent('nekko:feedback', {detail:'palette'}))"); await sleep(200);
      await check('the palette way in is reported as palette', "window.reports.some(r => r.event==='feedback_opened' && r.source==='palette')");
      await run("document.querySelector('[data-testid=feedback-kind-good]').click()"); await sleep(200);
      await run("document.querySelector('[aria-label=Close]').click()"); await sleep(150);
      await check('a prefill on its own is not a draft', "!document.querySelector('[data-testid=feedback-discard]') && !document.querySelector('[data-testid=feedback-sheet]')");

      await run("window.dispatchEvent(new CustomEvent('nekko:feedback', {detail:'about'}))"); await sleep(200);
      await run("document.querySelector('[data-testid=feedback-kind-good]').click()"); await sleep(200);
      await fill('#feedback-summary', 'Lovely'); await fill('#feedback-description', 'Local models just work.');
      await run("document.querySelector('[data-testid=feedback-send]').click()"); await sleep(150);
      await check('left on, the note carries both', "window.feedbackSent[0].includes('Name (optional): Ada Lovelace') && window.feedbackSent[0].includes('ada@example.com')");
      await check('no report carries the note or the contact', "!JSON.stringify(window.reports).match(/Ada|ada@|Lovely|model picker/)");
      await run("document.querySelector('[aria-label=Close]').click()"); await sleep(150);

      await run("layoutFixture.store.setState({settings:{...layoutFixture.store.getState().settings,userName:'',userEmail:''}})");
      await run("window.dispatchEvent(new CustomEvent('nekko:feedback', {detail:'rail'}))"); await sleep(200);
      await run("document.querySelector('[data-testid=feedback-kind-improve]').click()"); await sleep(200);
      await check('nothing saved, nothing filled and no switch', "document.querySelector('#feedback-name').value==='' && !document.querySelector('[data-testid=feedback-include-contact]')");
      await fill('#feedback-contact-email', 'grace@example.com'); await sleep(80);
      await check('typing an email brings the switch, worded for it', "document.querySelector('[data-testid=feedback-include-contact]').textContent==='Include my email'");
      win.setContentSize(390, 844); await sleep(300);
      await fill('#feedback-name', 'Grace'); await fill('#feedback-summary', 'Narrow'); await fill('#feedback-description', 'Check.'); await sleep(80);
      await run("document.querySelector('[data-testid=feedback-send]').scrollIntoView()"); await sleep(80);
      await shot('feedback-narrow');
      await check('narrow viewport does not overflow', 'document.documentElement.scrollWidth <= innerWidth');
      report.reports = await run('window.reports.filter(r => r.event===\'feedback_opened\')');
    } else {
      win.setContentSize(390, 844); await sleep(300); await shot('feedback-narrow');
    }
  } catch (e) { report.errors.push(String(e.stack || e)); process.exitCode = 1; }
  report.hidden = !win.isVisible(); report.focusable = win.isFocusable();
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(process.exitCode || (report.errors.length === 0 && report.captures.length >= 3 ? 0 : 1));
});
