// Full App fixture, isolated profile, no network or OS input.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Use layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
app.setPath('sessionData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const before = process.env.NEKKO_BEFORE === '1';
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ title: 'Greeting peek isolated verification', width: 1280, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -10000, y: -10000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const report = { checks: [], errors: [], captures: [] };
  win.on('show', () => report.errors.push('Window shown'));
  win.on('focus', () => report.errors.push('Window focused'));
  const run = code => win.webContents.executeJavaScript(code, true);
  const check = async (code, label) => { if (!await run(code)) throw Error(label); report.checks.push(label); };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    // Hidden app pauses its entrance animation at opacity zero; settle it for stills.
    await win.webContents.insertCSS('.clean-start-greeting.fade-in { animation: none; opacity: 1; }');
    for (let n = 0; n < 60 && !await run('!!window.layoutFixture'); n++) await sleep(100);
    await run(`(() => { const s=layoutFixture.store.getState(); layoutFixture.store.setState({settings:{...s.settings,commandWall:{...s.settings.commandWall,layout:{...s.settings.commandWall?.layout,mode:'focus'}}}}); layoutFixture.store.getState().focusChatOnWall('d'); })()`);
    for (let n = 0; n < 60 && !await run('!!document.querySelector("[data-clean-start-greeting]")'); n++) await sleep(100);
    for (const [width, height] of [[1280, 900], [460, 900]]) {
      win.setContentSize(width, height); await sleep(700);
      await check(`document.querySelector('[data-clean-start-greeting] h2')?.textContent === 'What should we work on?'`, 'Greeting renders at ' + width);
      if (!before) {
        await check(`(() => { const svg=document.querySelector('.greeting-nekko'), h=document.querySelector('[data-clean-start-greeting] h2'); if(!svg||!h)return false; const a=svg.getBoundingClientRect(),b=h.getBoundingClientRect(); return a.width>0 && a.width<=64 && a.right<=b.left && a.left>=0 && b.right<=innerWidth && svg.getAttribute('aria-hidden')==='true'; })()`, 'Decorative cat sits left of heading without overflow at ' + width);
        await check(`document.querySelector('[data-nekko-look]')?.getAttribute('transform') === 'translate(2 0)'`, 'Eyes look right at ' + width);
      }
      const file = path.join(out, 'greeting-' + width + '.png');
      fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(file);
    }
    await run(`(() => { const ed=document.querySelector('.composer [contenteditable="plaintext-only"], .composer textarea'); if(!ed)throw Error('Missing editor'); ed.focus(); if(ed.tagName==='TEXTAREA'){const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;set.call(ed,'Plan a small project');ed.dispatchEvent(new Event('input',{bubbles:true}));}else{document.execCommand('insertText',false,'Plan a small project');} })()`);
    await sleep(150);
    await check(`(() => {const ed=document.querySelector('.composer [contenteditable="plaintext-only"], .composer textarea'); return (ed?.value ?? ed?.textContent)==='Plan a small project';})()`, 'Composer still accepts typing');
    report.background = { visible: win.isVisible(), focused: win.isFocused(), bounds: win.getBounds() };
    if (win.isVisible() || win.isFocused()) throw Error('Isolation failed');
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (process.env.NEKKO_CAPTURE_HOLD === '1') await sleep(90000);
  win.destroy(); app.exit(report.errors.length ? 1 : 0);
});
