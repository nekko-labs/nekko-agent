// Matching Electron before/after, hidden/off-screen/non-focusable, isolated data, denied network.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Use layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
// Escape code delimiters and line separators before embedding JSON in evaluated code.
const js = v => JSON.stringify(v).replace(/[<>/\u2028\u2029]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
 const report = { checks: [], errors: [], captures: [] };
 session.defaultSession.webRequest.onBeforeRequest((r, done) => done({ cancel: !/^(file:|data:|blob:)/.test(r.url) }));
 session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
 const minX = Math.min(...screen.getAllDisplays().map(d => d.bounds.x));
 const minY = Math.min(...screen.getAllDisplays().map(d => d.bounds.y));
 const win = new BrowserWindow({ width: 1100, height: 960, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: minX - 2000, y: minY - 1400, title: 'Photo controls verification', webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
 win.on('focus', () => report.errors.push('took focus'));
 win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
 const run = js => win.webContents.executeJavaScript(js);
 const check = (name, passed) => { report.checks.push({ name, passed: !!passed }); };
 const shot = async name => { await sleep(300); fs.writeFileSync(path.join(out, name+'.png'), (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(name+'.png'); };
 const click = async text => {
  const p = await run(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim() === ${js(text)});if(!b)return null;b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);
  if (!p) throw Error('Missing button '+text);
  for (const type of ['mouseDown','mouseUp']) win.webContents.sendInputEvent({ type, ...p, button:'left', clickCount:1 });
  await sleep(400);
 };
 try {
  for (const width of [1100, 744, 390, 320]) {
   win.setContentSize(width, 960);
   await win.loadFile(path.join(out, 'index.html')); await sleep(700);
   for (const theme of ['dark','light']) {
    await run(`document.documentElement.dataset.theme='${theme}'`);
    await shot(`controls-${theme}-${width}`);
    check(`no horizontal overflow ${width} ${theme}`, await run('document.documentElement.scrollWidth <= innerWidth'));
   }
   if (process.env.NEKKO_PHOTO_BEFORE === '1') continue;
   check(`technical controls hidden ${width}`, !(await run(`!!document.querySelector('[aria-label="Steps"]')`)));
   await run(`(()=>{const s=document.querySelector('[aria-label="Image size"]');s.value='1024x768';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
   await sleep(200);
   check(`shape saves dimensions ${width}`, await run(`photoFixture.calls.some(c=>c.includes('"height":768'))`));
   await click('Advanced');
   check(`technical controls available ${width}`, await run(`!!document.querySelector('[aria-label="Steps"]')`));
   await click('Restore model defaults');
   check(`restores tuned defaults without changing shape ${width}`, await run(`(()=>{const c=photoFixture.calls.filter(c=>c.startsWith('{')).map(c=>JSON.parse(c)).at(-1)?.imageParams;return c?.steps===4 && c?.cfgScale===1 && c?.seed===-1 && c?.height===768;})()`));
   await shot(`advanced-${width}`);
   await click('Advanced');
   check(`runtime required before ready ${width}`, !(await run(`document.body.innerText.includes('Ready to create and edit photos')`)));
   await run('photoFixture.fail=true');
   await click('Finish photo setup');
   check(`setup failure visible ${width}`, await run(`document.body.innerText.includes('Fixture engine unavailable')`));
   await run('photoFixture.fail=false');
   await click('Finish photo setup');
   check(`retry reaches complete setup ${width}`, await run(`document.body.innerText.includes('Ready to create and edit photos')`));
   await shot(`ready-${width}`);
   await click('Open Photo');
   check(`opens photo chat ${width}`, await run(`photoFixture.calls.includes('open-chat')`));
   await run('photoFixture.missingFiles()'); await sleep(300);
   check(`missing files revoke readiness ${width}`, !(await run(`document.body.innerText.includes('Ready to create and edit photos')`)));
   await click('Finish photo setup');
   check(`existing engine reused while files are repaired ${width}`, await run(`photoFixture.calls.filter(c=>c==='install').length===2 && photoFixture.calls.includes('support') && document.body.innerText.includes('Ready to create and edit photos')`));
  }
 } catch(e) { report.errors.push(String(e.stack || e)); }
 report.success = !report.errors.length && report.checks.every(c => c.passed);
 fs.writeFileSync(path.join(out,'report.json'), JSON.stringify(report,null,2));
 console.log(JSON.stringify(report,null,2)); win.destroy(); app.exit(report.success ? 0 : 1);
}).catch(e=>{console.error(e);app.exit(1)});
