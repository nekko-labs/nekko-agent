const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const out = process.env.NEKKO_INTEGRATION_OUT;
const before = process.env.NEKKO_MEDIA_BASELINE === '1';
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ title: 'Nekko media evidence — isolated', width: 1200, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const checks = [];
  win.webContents.on('console-message', e => console.log(e.message));
  const run = async s => { try { return await win.webContents.executeJavaScript(s, true); } catch(e) { throw Error(s + '\n' + e); } };
  const shot = async name => { await sleep(350); fs.writeFileSync(path.join(out, name + '.png'), (await win.capturePage(undefined, { stayHidden: true })).toPNG()); };
  try {
    await win.loadFile(path.join(out, 'index.html')); await sleep(500);
    for (const theme of ['dark','light']) for (const width of [1200, 744, 390, 320]) {
      win.setContentSize(width, 900);
      await run(`document.documentElement.dataset.theme='${theme}';mediaFixture.reset()`); await sleep(100);
      await shot(`menu-${theme}-${width}`);
      if (before) continue;
      assert.equal(await run("document.querySelectorAll('[data-create-kind]').length"), 4);
      for (const kind of ['image','video']) {
        await run(`localStorage.removeItem('nekko.media-intro.${kind}.v1');document.querySelector('[data-create-kind="${kind}"]').click()`); await sleep(100);
        assert.equal(await run("!!document.querySelector('[role=dialog]')"), true);
        assert.equal(await run("(()=>{const r=document.querySelector('[role=dialog]').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight+1})()"), true);
        await shot(`${kind}-${theme}-${width}`);
        await run("document.querySelector('.media-intro-cta').click()"); await sleep(100);
        assert.equal(await run(`localStorage.getItem('nekko.media-intro.${kind}.v1')`), 'seen');
        await run('mediaFixture.reset()'); await sleep(80);
        await run(`document.querySelector('[data-create-kind="${kind}"]').click()`); await sleep(80);
        assert.equal(await run("!!document.querySelector('[role=dialog]')"), false);
        await run("document.querySelector('.media-agent-label button').click()"); await sleep(80);
        assert.equal(await run("!!document.querySelector('[role=dialog]')"), true);
        await run("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"); await sleep(80);
        assert.equal(await run("!!document.querySelector('[role=dialog]')"), false);
        await run('mediaFixture.reset()'); await sleep(80);
        checks.push(`${kind} ${theme} ${width}: bounds, CTA, independent persisted acknowledgement, replay, Escape`);
      }
    }
    fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({before,checks},null,2));
    console.log(JSON.stringify({out,before,checks}));
    if (process.env.NEKKO_MEDIA_HOLD === '1') { win.setContentSize(1200,900); await run("document.documentElement.dataset.theme='dark';localStorage.removeItem('nekko.media-intro.video.v1');mediaFixture.choose('video')"); console.log('Holding isolated window for native capture'); return; }
  } catch(e) { console.error(e); process.exitCode=1; }
  win.destroy(); app.exit(process.exitCode || 0);
});
