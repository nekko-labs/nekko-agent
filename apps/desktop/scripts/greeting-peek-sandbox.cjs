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
    await run('layoutFixture.showGreeting()');
    for (let n = 0; n < 60 && !await run('!!document.querySelector("[data-clean-start-greeting]")'); n++) await sleep(100);
    for (const [width, height] of [[1280, 900], [460, 900]]) {
      win.setContentSize(width, height); await sleep(700);
      await check(`document.querySelector('[data-clean-start-greeting] h2')?.textContent === 'What should we work on?'`, 'Greeting renders at ' + width);
      if (!before) {
        await check(`(() => { const svg=document.querySelector('.greeting-nekko'), composer=svg?.closest('.composer-section'); if(!svg||!composer)return false; const a=svg.getBoundingClientRect(),b=composer.getBoundingClientRect(); return a.left>b.left && a.right<b.right && svg.getAttribute('aria-hidden')==='true'; })()`, 'Cat stays within composer section at ' + width);
        await check(`(() => { const a=document.querySelector('.greeting-nekko-slot').getBoundingClientRect(), b=document.querySelector('[data-clean-start-greeting] h2').getBoundingClientRect(); const g=document.querySelector('[data-clean-start-greeting]').getBoundingClientRect(); return a.right<=b.left && Math.abs((a.left+b.right)/2-(g.left+g.width/2))<3; })()`, 'Cat does not overlap heading at ' + width);
        await check(`(() => { const a=document.querySelector('.greeting-nekko').getBoundingClientRect(), b=document.querySelector('.composer').getBoundingClientRect(); return a.width===80 && Math.abs(a.top+a.height*25/30-b.top)<2; })()`, 'Larger paws straddle composer border at ' + width);
        await check(`!document.querySelector('.greeting-nekko path[d="M0 25H32"]')`, 'No artificial ledge at ' + width);
        await check(`(() => { const face=document.querySelector('[data-part="peek-face"]'), composer=document.querySelector('.composer'); return face?.getAttribute('overflow')==='hidden' && Math.abs(face.getBoundingClientRect().bottom-composer.getBoundingClientRect().top)<2; })()`, 'Face clips at composer edge at ' + width);
        await check(`document.querySelector('[data-part="peek-paws"]')?.getAttribute('transform') === 'translate(0 50) scale(1 -1)'`, 'Toes point down at ' + width);
      }
      const file = path.join(out, 'greeting-' + width + '.png');
      fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(file);
    }
    if (!before) {
      await run(`Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange'))`);
      const rotationFrames = [(await win.capturePage(undefined, {stayHidden:true})).resize({width:460}).toPNG()];
      await sleep(8300);
      rotationFrames.push((await win.capturePage(undefined, {stayHidden:true})).resize({width:460}).toPNG());
      require('./evidence-gif.cjs')(path.join(out,'question-rotation.gif'), rotationFrames, 800);
      await check(`document.querySelector('[data-clean-start-greeting] h2').textContent !== 'What should we work on?'`, 'Idle question rotates');
    }
    await run(`(() => { const ed=document.querySelector('.composer [contenteditable="plaintext-only"]'); ed.focus(); ed.textContent='Plan a small project with a friendly cat'; ed.dispatchEvent(new Event('input',{bubbles:true})); ed.setSelectionRange(0,0); })()`);
    await sleep(500);
    await check(`document.querySelector('.composer [contenteditable="plaintext-only"]').value==='Plan a small project with a friendly cat'`, 'Composer accepts text');
    if (!before) {
      const heading = await run(`document.querySelector('[data-clean-start-greeting] h2').textContent`);
      await sleep(8200);
      await check(`document.querySelector('[data-clean-start-greeting] h2').textContent === ${JSON.stringify(heading)}`, 'Typing pauses question rotation');
      // The editor restores selection after painting input. Move the caret only
      // after that paint, then wait for the observable selection and gaze.
      const select = async offset => {
        await run(`document.querySelector('.composer [contenteditable="plaintext-only"]').setSelectionRange(${offset},${offset})`);
        for (let n=0;n<40;n++) {
          await sleep(50);
          if (await run(`document.querySelector('.composer [contenteditable="plaintext-only"]').selectionStart === ${offset}`)) {
            await sleep(100);
            return;
          }
        }
        throw Error('Caret did not settle at ' + offset);
      };
      await select(0);
      const start = await run(`document.querySelector('[data-nekko-look]').getAttribute('transform')`);
      await select(38);
      await sleep(500);
      await check(`document.querySelector('[data-nekko-look]').getAttribute('transform') !== ${JSON.stringify(start)}`, 'Eyes follow selection movement');
      const frames = [];
      for (const offset of [0, 8, 18, 28, 38, 28, 18, 8, 0]) {
        await run(`document.querySelector('.composer [contenteditable="plaintext-only"]').setSelectionRange(${offset},${offset})`);
        await sleep(120);
        frames.push((await win.capturePage(undefined, {stayHidden:true})).resize({width:460}).toPNG());
      }
      require('./evidence-gif.cjs')(path.join(out,'caret-gaze.gif'),frames,18);
    }
    if (!before) {
      win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'reduce'}]});
      await run(`(() => { const ed=document.querySelector('.composer [contenteditable="plaintext-only"]'); ed.textContent=''; ed.dispatchEvent(new Event('input',{bubbles:true})); })()`);
      await sleep(300);
      const heading = await run(`document.querySelector('[data-clean-start-greeting] h2').textContent`);
      await sleep(8300);
      await check(`document.querySelector('[data-clean-start-greeting] h2').textContent === ${JSON.stringify(heading)}`, 'Reduced motion disables automatic rotation');
      win.webContents.debugger.detach();
    }
    report.background = { visible: win.isVisible(), focused: win.isFocused(), bounds: win.getBounds() };
    if (win.isVisible() || win.isFocused()) throw Error('Isolation failed');
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (process.env.NEKKO_CAPTURE_HOLD === '1') await sleep(90000);
  win.destroy(); app.exit(report.errors.length ? 1 : 0);
});
