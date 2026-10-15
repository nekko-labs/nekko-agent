const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const dir = process.env.NEKKO_EVIDENCE_DIR, kind = process.env.NEKKO_EVIDENCE_KIND;
app.commandLine.appendSwitch('force-device-scale-factor', '1');
const profile = fs.mkdtempSync(path.join(dir, 'profile-')); app.setPath('userData', profile); app.setPath('sessionData', profile);
const report = { kind, revision: kind === 'before' ? process.env.NEKKO_EVIDENCE_BASE : 'working-source', checks: [], errors: [], captures: [], visuallyInspected: false };
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((r, done) => done({ cancel: !/^(file:|data:|blob:)/.test(r.url) }));
  session.defaultSession.setPermissionRequestHandler((w, p, d) => d(false)); session.defaultSession.setPermissionCheckHandler(() => false);
  const left = Math.min(...screen.getAllDisplays().map(d => d.bounds.x));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: left - 5000, y: -3000, title: 'Isolated wall empty evidence', webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('Unexpected OS focus')); win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const stable = async () => { await run('document.fonts.ready'); await sleep(350); };
  const check = async (name, code) => report.checks.push({ name, passed: !!await run(code) });
  const capture = async name => { await stable(); const img = await win.capturePage(undefined, { stayHidden: true, stayAwake: true }); if (img.isEmpty()) throw Error('Empty screenshot'); fs.writeFileSync(path.join(dir, name + '.png'), img.toPNG()); report.captures.push({ name, actualPixels: img.getSize(), dom: await run(`(()=>{const s=document.querySelector('.command-wall-stage'),e=s.querySelector('.command-wall-empty'),r=s.getBoundingClientRect();return {width:innerWidth,height:innerHeight,deviceScale:devicePixelRatio,vacant:s.hasAttribute('data-wall-vacant'),stage:{x:r.x,y:r.y,width:r.width,height:r.height},emptyPosition:e&&getComputedStyle(e).position,listItems:s.querySelectorAll('li').length,scrollTop:s.parentElement.scrollTop}})()`) }); };
  try {
    await win.loadFile(path.join(dir, 'index.html')); win.showInactive(); await stable();
    for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
      win.setContentSize(width, 900);
      for (let i = 0; i < 8; i++) { await sleep(100); const v = await run('({w:innerWidth,h:innerHeight})'); if (v.w === width && v.h === 900) break; const b = win.getBounds(); win.setBounds({ ...b, width: b.width + width - v.w, height: b.height + 900 - v.h }); }
      await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      for (const scenario of ['empty', 'filtered', 'creation', 'streaming']) {
        await run(`evidence.configure(${JSON.stringify(scenario)})`); await stable();
        const label = `${width}-${theme}-${scenario}`;
        await check(label + ' viewport', `innerWidth===${width}&&innerHeight===900`);
        if (scenario === 'empty') await check(label + ' centered illustration', `(()=>{const s=document.querySelector('.command-wall-stage').getBoundingClientRect(),e=document.querySelector('.command-wall-empty-state').getBoundingClientRect();return Math.abs(e.x+e.width/2-s.x-s.width/2)<2&&Math.abs(e.y+e.height/2-s.y-s.height/2)<2})()`);
        if (scenario === 'filtered') await check(label + ' not full centered', `getComputedStyle(document.querySelector('.command-wall-empty')).position!=='absolute'&&!document.querySelector('[data-wall-empty]')`);
        if (scenario === 'creation') await check(label + ' creation tile only', `!!document.querySelector('.command-wall-add-tile')&&!document.querySelector('.command-wall-empty')`);
        if (kind === 'after') await check(label + ' state-owned vacancy', `document.querySelector('.command-wall-stage').hasAttribute('data-wall-vacant')===${scenario === 'empty'}`);
        await capture(label);
        if (scenario === 'streaming') {
          const before = await run(`(()=>{const s=document.querySelector('.command-wall-stage');return {h:s.getBoundingClientRect().height,top:s.parentElement.scrollTop}})()`);
          for (let i = 0; i < 8; i++) { await run('evidence.append()'); await sleep(30); }
          await check(label + ' appended changing descendants', `document.querySelectorAll('.command-wall-stage li').length===10`);
          await check(label + ' stage and scroll unchanged', `(()=>{const s=document.querySelector('.command-wall-stage');return Math.abs(s.getBoundingClientRect().height-${before.h})<1&&s.parentElement.scrollTop===${before.top}})()`);
          await capture(label + '-appended');
        }
      }
    }
    report.background = { focused: win.isFocused(), visible: win.isVisible(), focusable: win.isFocusable(), bounds: win.getBounds(), profile, offscreen: win.getBounds().x + win.getBounds().width < left };
  } catch (e) { report.errors.push(String(e)); try { report.debug = await run('document.body.innerText'); await capture('failure-debug'); } catch (_) {} }
  finally { fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ kind, captures: report.captures.length, failed: report.checks.filter(c => !c.passed), errors: report.errors }, null, 2)); win.destroy(); app.exit(report.errors.length || report.checks.some(c => !c.passed) ? 1 : 0); }
});
