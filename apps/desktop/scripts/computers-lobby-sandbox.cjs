// Settings > Computers pairing a computer on this network (CC8): the joiner's
// list and code, and the host's Pair prompt. Run through
// layout-evidence-integration.cjs with NEKKO_LAYOUT_FIXTURE=computers-section-fixture.tsx
// NEKKO_LAYOUT_SANDBOX=computers-lobby-sandbox.cjs (NEKKO_TEST_SOURCE for "before").
// Hidden, off-screen, non-focusable window, isolated profile, network blocked.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { checks: [], errors: [] };
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  const win = new BrowserWindow({ width: 700, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -10000, y: -10000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('show', () => report.errors.push('Window became visible'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  const run = code => win.webContents.executeJavaScript(code, true);
  const click = label => run(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)}); if (b) b.click(); return !!b; })()`);
  const shot = async name => {
    await sleep(500);
    for (let i = 0; i < 2; i++) { win.webContents.invalidate(); await sleep(400); await win.capturePage(undefined, { stayHidden: true }); }
    fs.writeFileSync(path.join(out, `${name}.png`), (await win.capturePage(undefined, { stayHidden: true })).toPNG());
    return run('document.body.innerText');
  };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    await sleep(1200);
    await click('Add a computer');
    const list = await shot('lobby-nearby');
    report.checks.push({ name: 'Add a computer lists Studio on this network', pass: /On this network/.test(list) && /Studio/.test(list) });
    await run(`document.querySelector('[data-nearby] li button').click()`);
    const code = await shot('lobby-code');
    report.checks.push({ name: 'Connect shows the code to compare', pass: /Check that Studio shows 482 913/.test(code) });
    await win.loadFile(path.join(out, 'index.html'));
    await sleep(1200);
    await run(`window.lobbyEmit && window.lobbyEmit({ state: 'asking', name: 'MacBook', code: '482 913' })`);
    const asking = await shot('lobby-asking');
    report.checks.push({ name: 'The host asks to pair with the same code', pass: /MacBook on this network wants to connect/.test(asking) && /482 913/.test(asking) });
  } catch (e) { report.errors.push(String(e && e.stack || e)); process.exitCode = 1; }
  console.log(JSON.stringify(report, null, 2));
  app.exit(process.exitCode || 0);
});
