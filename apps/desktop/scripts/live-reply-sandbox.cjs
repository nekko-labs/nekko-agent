// Synthetic live-reply evidence; never connects to the user's host or profile.
// Launched through live-reply-integration.cjs (NEKKO_TEST_REVISION=<rev> for "before").
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through live-reply-integration.cjs');
const base = !!process.env.NEKKO_TEST_REVISION;
const dir = path.join(out, base ? 'before' : 'after');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
app.setPath('userData', path.join(dir, 'profile'));
app.setPath('sessionData', path.join(dir, 'profile'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((request, done) => done({ cancel: !/^(file:|data:|blob:)/.test(request.url) }));
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, done) => done(false));
  const left = Math.min(...screen.getAllDisplays().map(d => d.bounds.x));
  const win = new BrowserWindow({
    width: 1100, height: 720, useContentSize: true, show: false, focusable: false, skipTaskbar: true,
    x: left - 3000, y: -2000, title: 'Synthetic live reply verification',
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  const report = { checks: [], errors: [], measures: {} };
  win.on('focus', () => report.errors.push('Fixture took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push('console: ' + e.message); });
  const run = source => win.webContents.executeJavaScript(source, true);
  const check = async (name, source) => { let ok = false; try { ok = !!await run(source); } catch (e) { report.errors.push(name + ': ' + e); } report.checks.push({ name, passed: ok }); };
  const capture = async name => { await sleep(300); fs.writeFileSync(path.join(dir, name + '.png'), (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG()); };
  // How many assistant bubbles carry the narration, and how many Done rows there are.
  const measure = "(()=>{const b=[...document.querySelectorAll('.msg-ai')].filter(e=>/reading the workspace guidance/.test(e.textContent));return {narrationBubbles:b.length,doneRows:document.querySelectorAll('[data-done-row]').length,bubbles:b.map(e=>({row:(e.closest('[data-vt-key]')||{dataset:{}}).dataset.vtKey||'footer',done:!!e.querySelector('[data-done-row]')})),activityGroups:document.querySelectorAll('[aria-expanded]').length}})()";
  try {
    await win.loadFile(path.join(out, 'index.html'));
    win.showInactive();
    await sleep(1200);
    for (const t of ['dark', 'light']) {
      await run(`integration.reset({running:true})`); await sleep(1200);
      await run(`document.documentElement.dataset.theme='${t}'`); await sleep(300);
      report.measures[`running-${t}`] = await run(measure);
      await check(`running: the narration is drawn once, by the live turn, with no Done row (${t})`, `(()=>{const m=${measure};return m.narrationBubbles===1&&m.bubbles[0].row==='footer'&&m.doneRows===0})()`);
      await capture(`running-${t}`);
      await run(`integration.reset({running:false})`); await sleep(1200);
      await run(`document.documentElement.dataset.theme='${t}'`); await sleep(300);
      report.measures[`finished-${t}`] = await run(measure);
      await check(`finished: the persisted narration is drawn once, in the transcript (${t})`, `(()=>{const m=${measure};return m.narrationBubbles===1&&m.bubbles[0].row!=='footer'})()`);
      await capture(`finished-${t}`);
    }
    report.success = !report.errors.some(e => /focus/.test(e)) && (base || report.checks.every(c => c.passed));
  } catch (error) {
    report.errors.push(String(error)); report.success = false;
  } finally {
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ dir, success: report.success, failed: report.checks.filter(c => !c.passed).map(c => c.name), errors: report.errors.slice(0, 6), measures: report.measures }, null, 2));
    win.destroy(); app.exit(report.success ? 0 : 1);
  }
});
