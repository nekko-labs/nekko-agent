// Real ChatPane, synthetic bridge only. No network, provider, user profile or OS input.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
app.setPath('userData', path.join(out, 'profile'));
app.setPath('sessionData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const left = Math.min(...screen.getAllDisplays().map(d => d.bounds.x));
  const win = new BrowserWindow({ width: 1000, height: 800, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: left - 4000, y: -3000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const report = { checks: [], errors: [] };
  win.on('show', () => report.errors.push('became visible'));
  win.on('focus', () => report.errors.push('took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const check = (name, passed) => report.checks.push({ name, passed: !!passed });
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 60 && !(await run('!!window.layoutFixture')); i++) await sleep(200);
    await run('layoutFixture.showRetry()');
    await sleep(800);
    await run(`(() => {
      const r = layoutFixture.records[0];
      r.messages = [{id:'u1',role:'user',content:'Inspect the remaining screenshots.',createdAt:1},{id:'a1',role:'assistant',content:'The screenshots are saved as PNG files. Browser screenshots timed out; the remaining images still need inspection.',createdAt:2}];
      layoutFixture.putCachedSession(r);
      layoutFixture.bridge.suggestReplies = async () => ({ options: ['Inspect the saved PNGs directly', 'Try another image viewer', 'Leave the PR on hold for now'], next: 'Can you open the saved PNGs directly to inspect them instead of taking new browser screenshots?' });
      layoutFixture.emitAgent({type:'done',sessionId:'a',messageId:'a1'});
    })()`);
    await sleep(1000);
    const after = await run("!!document.querySelector('[data-follow-up-choices]')");
    check('no automatic send', await run('!layoutFixture.lastSend'));
    for (const [label, width, height] of [['desktop',1000,800],['narrow',390,800]]) {
      win.setContentSize(width,height); await sleep(500);
      const visible = await run(`!!document.querySelector('${after ? '[data-follow-up-choices]' : '[data-work-place]'}')`);
      check(label + ': choices visible', visible);
      if (after) check(label + ': controls fit viewport', await run(`(() => { const e = document.querySelector('[data-follow-up-choices]'); return [...e.querySelectorAll('button, select')].every(b => {const r=b.getBoundingClientRect(); return r.left>=0 && r.right<=innerWidth}); })()`));
      await win.capturePage(undefined, {stayHidden:true}); await sleep(200);
      fs.writeFileSync(path.join(out, label + '.png'), (await win.capturePage(undefined, {stayHidden:true,stayAwake:false})).toPNG());
    }
    if (after) {
      await run("document.querySelector('[data-follow-up-choices] button').click()"); await sleep(500);
      check('click sends exact contextual choice, not ghost question', await run("layoutFixture.lastSend?.text === 'Inspect the saved PNGs directly'"));
      check('choices disappear after sending', await run("!document.querySelector('[data-follow-up-choices]')"));
      await run("layoutFixture.emitAgent({type:'done',sessionId:'a',messageId:'a1'})"); await sleep(700);
      await run("document.querySelector('[data-follow-up-location] [value=\"subagent\"]').click()");
      await sleep(100);
      await run("document.querySelector('[data-follow-up-choices] button').click()"); await sleep(400);
      check('optional delegation wraps selected response only', await run("layoutFixture.lastSend?.text === 'Do this in a subagent, then report back:\\n\\nInspect the saved PNGs directly'"));
      await run(`layoutFixture.bridge.suggestReplies = () => new Promise(resolve => { window.resolveSuggestion = resolve; }); layoutFixture.emitAgent({type:'done',sessionId:'a',messageId:'a1'});`);
      await sleep(300);
      await run(`(() => { const r = layoutFixture.records[0]; r.messages = [...r.messages, {id:'new-answer',role:'assistant',content:'A newer reply',createdAt:3}]; layoutFixture.putCachedSession(r); window.resolveSuggestion({options:['Outdated choice'],next:'Outdated next'}); })()`);
      await sleep(500);
      check('late suggestions cannot attach to a newer assistant reply', await run("!document.querySelector('[data-follow-up-choices]')"));
    }
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
  win.destroy(); app.exit(report.errors.length || report.checks.some(c=>!c.passed) ? 1 : 0);
});
