// The closed permissions menu with each switch state; isolated hidden Electron, synthetic bridge only.
// NEKKO_LAYOUT_SANDBOX=permission-marks-sandbox.cjs node apps/desktop/scripts/layout-evidence-integration.cjs
// Set NEKKO_TEST_SOURCE to the unchanged base checkout and NEKKO_TEST_LABEL=before for baseline.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Use layout-evidence-integration.cjs');
const before = !!process.env.NEKKO_TEST_SOURCE;
app.setPath('userData', path.join(out, 'profile'));
app.setPath('sessionData', path.join(out, 'profile'));
app.disableHardwareAcceleration();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { before, checks: [], captures: [], errors: [] };
// Each state seeds the chat before the real ChatPane mounts.
const STATES = [
  ['defaults', '{}', []],
  ['incognito-shield', "{incognito:true,privacy:{mode:'redact'}}", ['incognito', 'shield']],
  ['offline', '{offline:true}', ['internet']],
  ['all', "{incognito:true,privacy:{mode:'redact'},offline:true}", ['incognito', 'shield', 'internet']],
];
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1100, height: 720, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -10000, y: -10000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('show', () => report.errors.push('Became visible'));
  win.on('focus', () => report.errors.push('Took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = code => win.webContents.executeJavaScript(code, true);
  const wait = async selector => { for (let i = 0; i < 80; i++) { if (await run('!!document.querySelector(' + JSON.stringify(selector) + ')')) return; await sleep(100); } throw Error('Missing ' + selector); };
  const check = async (name, code) => { const value = await run(code); report.checks.push({ name, value }); if (!value) throw Error(name); };
  const shot = async name => {
    await run('document.getAnimations().forEach(a=>{if(a.effect?.getTiming().iterations!==Infinity)try{a.finish()}catch{}})'); await sleep(100);
    // The trigger and its neighbours in the composer's foot row.
    const rect = await run(`(()=>{const r=document.querySelector('[data-asks-first]').getBoundingClientRect();const x=Math.max(0,Math.floor(r.left)-160);return {x,y:Math.max(0,Math.floor(r.top)-12),width:Math.min(innerWidth-x,Math.ceil(r.width)+320),height:Math.ceil(r.height)+24}})()`);
    await win.capturePage(rect, { stayHidden: true }); await sleep(100);
    const file = path.join(out, (before ? 'before-' : 'after-') + name + '.png');
    fs.writeFileSync(file, (await win.capturePage(rect, { stayHidden: true })).toPNG()); report.captures.push(file);
  };
  try {
    await win.loadURL('about:blank');
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Page.enable');
    await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: "localStorage.setItem('nekko.commandWall',JSON.stringify({root:{id:'a-pane',kind:'chat',refId:'a'},hero:'a',watermark:1,zonesIntro:true,autoAdd:false,layout:{mode:'focus'},dock:{show:false},agentPanel:{show:false}}));" });
    await win.loadFile(path.join(out, 'index.html')); await sleep(700);
    for (const expert of [false, true]) {
      for (const [name, seed, keys] of STATES) {
        await run(`layoutFixture.composerSeed=r=>Object.assign(r,{incognito:false,privacy:undefined,offline:false},${seed});0`);
        // A different pane in between, so the chat remounts with the seeded settings.
        await run('layoutFixture.showComposer("composer")'); await sleep(300);
        await run(`layoutFixture.showFolderComposer(false, ${expert}, "full")`); await wait('[data-asks-first]'); await sleep(600);
        const label = (expert ? 'expert-' : 'simple-') + name;
        report.checks.push({ name: 'Seen ' + label, value: await run(`({label:document.querySelector('[data-asks-first]').getAttribute('aria-label'),record:JSON.stringify({i:layoutFixture.records[0].incognito,p:layoutFixture.records[0].privacy,o:layoutFixture.records[0].offline})})`) });
        if (!before) {
          await check('Marks ' + label, `JSON.stringify([...document.querySelectorAll('[data-asks-first] [data-permission-mark]')].map(e=>e.dataset.permissionMark))===${JSON.stringify(JSON.stringify(keys))}`);
          await check('Label names marks ' + label, `(()=>{const l=document.querySelector('[data-asks-first]').getAttribute('aria-label');return ${keys.length} ? l.includes(', ') : !l.includes(',')})()`);
          await check('Trigger stays on one row ' + label, `document.querySelector('[data-asks-first]').getBoundingClientRect().height<=30`);
        }
        await shot(label);
      }
    }
    report.background = { visible: win.isVisible(), focused: win.isFocused(), bounds: win.getBounds() };
    if (report.background.visible || report.background.focused) throw Error('Unsafe window state');
  } catch (e) { report.errors.push(String(e.stack || e)); }
  finally { fs.writeFileSync(path.join(out, 'marks-report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ checks: report.checks.length, errors: report.errors })); win.destroy(); app.exit(report.errors.length ? 1 : 0); }
});
