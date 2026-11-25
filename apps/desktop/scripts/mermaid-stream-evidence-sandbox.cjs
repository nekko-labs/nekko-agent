// Isolated component evidence for a Mermaid fence while it streams. No bridge, real data, network or visible window.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
app.setPath('sessionData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const intro = 'Here is how a request flows through the app.\n\n';
const stages = [
  ['1-open-fence-streaming', intro + '```mermaid\ngraph TD\n  A[Window] --> B[Daemon]\n  B --> C'],
  ['2-open-fence-more', intro + '```mermaid\ngraph TD\n  A[Window] --> B[Daemon]\n  B --> C[Model]\n  C --> D[Reply]'],
  ['3-fence-closed', intro + '```mermaid\ngraph TD\n  A[Window] --> B[Daemon]\n  B --> C[Model]\n  C --> D[Reply]\n```\n\nThe diagram above is drawn once the fence closes.'],
];
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 900, height: 420, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -5000, y: -5000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const report = { errors: [], captures: [] };
  win.on('show', () => report.errors.push('Window became visible'));
  win.on('focus', () => report.errors.push('Window took focus'));
  const run = s => win.webContents.executeJavaScript(s, true);
  const png = async () => { await win.capturePage(undefined, { stayHidden: true }); await sleep(150); return (await win.capturePage(undefined, { stayHidden: true })).toPNG(); };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    await sleep(800);
    const frames = [];
    for (const [name, text] of stages) {
      await run(`window.setReply(${JSON.stringify(text)})`);
      await sleep(name.startsWith('3') ? 2500 : 600);
      const file = path.join(out, name + '.png');
      const buf = await png();
      fs.writeFileSync(file, buf); report.captures.push(file); frames.push(buf);
      report[name] = await run("({ codeBlocks: document.querySelectorAll('[data-code-block]').length, iframes: document.querySelectorAll('iframe').length, text: document.body.innerText.slice(0, 200) })");
    }
    const gif = path.join(out, 'mermaid-stream.gif');
    require('./evidence-gif.cjs')(gif, frames.flatMap(f => [f, f, f]), 60);
    report.captures.push(gif);
    report.success = report.errors.length === 0;
  } catch (e) { report.errors.push(String(e.stack || e)); report.success = false; }
  finally {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2)); win.destroy(); app.exit(report.success ? 0 : 1);
  }
});
