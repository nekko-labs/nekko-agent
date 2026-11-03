const { app, BrowserWindow, screen, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url)}));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const minX = Math.min(...screen.getAllDisplays().map(d => d.bounds.x));
  const minY = Math.min(...screen.getAllDisplays().map(d => d.bounds.y));
  const win = new BrowserWindow({ width: 960, height: 760, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: minX - 1200, y: minY - 900, webPreferences: {sandbox: true, contextIsolation: true, backgroundThrottling: false} });
  const report = {captures: [], checks: {}, errors: []};
  win.webContents.on('console-message', e => { if(e.level === 'error') report.errors.push(e.message.slice(0,300)); });
  const run = s => win.webContents.executeJavaScript(s, true);
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for(let i=0;i<50 && !await run('!!window.catalogFixture');i++) await sleep(100);
    for(const [name, args] of [['chatgpt', ['chatgpt','gpt-6-sol']], ['claude', ['claude','opus','claude-opus-5-5']]]) {
      await run(`window.catalogFixture.render(...${JSON.stringify(args)})`);
      await sleep(250);
      for(const width of [960,390]) {
        win.setContentSize(width,760);
        await sleep(250);
        const file = path.join(out, `${name}-${width}.png`);
        fs.writeFileSync(file, (await win.capturePage(undefined, {stayHidden:true})).toPNG());
        report.captures.push(file);
      }
      report.checks[name] = await run(`Array.from(document.querySelectorAll('[data-model-name]')).map(x => x.textContent)`);
    }
    await run(`Array.from(document.querySelectorAll('[role=option]')).find(x=>x.textContent.includes('Claude Opus')).click()`);
    report.checks.picked = await run('window.catalogFixture.picked');
    report.checks.hidden = !win.isVisible();
  } catch(e) {report.errors.push(String(e.stack || e));}
  fs.writeFileSync(path.join(out,'report.json'), JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
  app.exit(report.errors.length || !report.checks.hidden || report.checks.picked !== 'opus' ? 1 : 0);
});
