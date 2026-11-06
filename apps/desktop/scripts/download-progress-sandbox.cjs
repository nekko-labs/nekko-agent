// Run via layout-evidence-integration.cjs; hidden, isolated, network blocked.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { checks: [], errors: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, cb) => cb(false));
  const win = new BrowserWindow({ width: Number(process.env.NEKKO_TEST_WIDTH || 1100), height: 1600, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -2200, y: -1800, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const run = s => win.webContents.executeJavaScript(s, true);
  const check = async (name, s) => { const passed = !!await run(s); report.checks.push({ name, passed }); if (!passed) throw Error(name); };
  const shot = async name => fs.writeFileSync(path.join(out, name + '.png'), (await win.capturePage(undefined, { stayHidden: true })).toPNG());
  win.on('focus', () => report.errors.push('took focus'));
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 50 && !await run('!!window.downloadFixture && !!document.querySelector("[data-fixture=diffusion] .btn-primary")'); i++) await sleep(150);
    await sleep(300); await shot('idle');
    await run(`for (const scope of ['model','llama','diffusion','mlx','recommendation','decision']) { const root=document.querySelector('[data-fixture="'+scope+'"]'); const b=Array.from(root.querySelectorAll('button')).find(e=>/^(Download|Install)/.test(e.textContent.trim())); b.click(); b.click(); }`);
    const baseline = process.env.NEKKO_TEST_BASELINE === '1';
    if (!baseline) await check('immediate locked progress', `['model','llama','diffusion','mlx','recommendation','decision'].every(s=>{const r=document.querySelector('[data-fixture="'+s+'"]'); return !!r.querySelector('button:disabled') && !!r.querySelector('[role=progressbar]');})`);
    await sleep(700); await shot('queued');
    if (!baseline) await check('queued locks survive request response', `['model','llama','diffusion','mlx','recommendation','decision'].every(s=>!!document.querySelector('[data-fixture="'+s+'"] button:disabled'))`);
    await run(`downloadFixture.emit('downloading',42)`); await sleep(300); await shot('downloading');
    await run(`document.querySelector('[data-fixture=diffusion]').scrollIntoView({block:'center'})`); await sleep(200); await shot('runtimes');
    await run(`document.querySelector('[data-fixture=recommendation]').scrollIntoView({block:'start'})`); await sleep(200); await shot('extras');
    await run('window.scrollTo(0,0)');
    if (!baseline) {
      for (const percent of [10, 42, 70, 100]) { await run(`downloadFixture.emit('downloading',${percent})`); await sleep(150); await shot('motion-'+percent); }
      await run(`downloadFixture.emit('downloading',42)`); await sleep(150);
    }
    if (!baseline) {
      await check('all controls show 42 percent', `document.querySelectorAll('[role=progressbar][aria-valuenow="42"]').length===6`);
      await check('one request per control', `Object.values(downloadFixture.calls).every(n=>n===1)&&Object.keys(downloadFixture.calls).length===5`);
      await run(`downloadFixture.emit('verifying',100)`); await sleep(200);
      await check('verifying remains locked', `document.querySelectorAll('[role=progressbar]').length===6`);
      await shot('verifying');
      await run(`downloadFixture.emit('failed',42)`); await sleep(200);
      await check('failure releases controls', `!document.querySelector('[role=progressbar]') && !document.querySelector('[data-fixture=llama] button:disabled')`);
      await run(`document.querySelector('[data-fixture=llama] .btn-primary').click()`); await sleep(600);
      await check('failure permits retry', `downloadFixture.calls['engine:llama:fixture-metal']===2`);
      await run(`downloadFixture.emit('cancelled')`); await sleep(200);
      await check('cancellation releases controls', `!document.querySelector('[role=progressbar]')`);
      await run(`document.querySelector('[data-fixture=llama] .btn-primary').click()`); await sleep(600);
      await run(`downloadFixture.emit('done',100)`); await sleep(200);
      await check('completion releases controls', `!document.querySelector('[role=progressbar]')`);
    }
    report.calls = await run('downloadFixture.calls'); report.hidden = !win.isVisible(); report.bounds = win.getBounds();
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out,'report.json'), JSON.stringify(report,null,2)); console.log(JSON.stringify(report,null,2));
  win.destroy(); app.exit(report.errors.length ? 1 : 0);
});
