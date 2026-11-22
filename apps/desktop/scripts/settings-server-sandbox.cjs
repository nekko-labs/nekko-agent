// Synthetic renderer-only evidence. No host, user profile, OS input or network.
// The window is hidden, non-focusable and parked off every display.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch with settings-server-integration.cjs');
const profile = fs.mkdtempSync(path.join(out, 'profile-'));
app.setPath('userData', profile);
app.setPath('sessionData', profile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const report = { checks: [], errors: [], blockedNetwork: [] };
  session.defaultSession.webRequest.onBeforeRequest((r, done) => {
    const cancel = !/^(file:|data:|blob:)/.test(r.url);
    if (cancel) report.blockedNetwork.push(r.url);
    done({ cancel });
  });
  session.defaultSession.setPermissionRequestHandler((_c, _p, done) => done(false));
  const left = Math.min(...screen.getAllDisplays().map(d => d.bounds.x));
  const win = new BrowserWindow({ width: 1280, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: left - 4500, y: -3000, title: 'Isolated Settings verification', webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('Fixture took focus'));
  // Only the Server section is under test; the fixture stubs nothing the other sections need.
  win.webContents.on('console-message', e => { if (e.level === 'error' && /AgentServer|Agent server|railWheel/.test(e.message)) report.errors.push(e.message.slice(0, 300)); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const check = async (name, source) => { report.checks.push({ name, passed: !!await run(source) }); };
  const capture = async name => {
    const image = await win.capturePage(undefined, { stayHidden: true, stayAwake: false });
    if (image.isEmpty()) throw Error('Empty capture: ' + name);
    fs.writeFileSync(path.join(out, name + '.png'), image.toPNG());
  };
  try {
    await win.loadFile(path.join(out, 'index.html')); win.showInactive(); await sleep(2000);
    await check('Server sits after Connectors in the rail top block', "(()=>{const b=[...document.querySelectorAll('.settings-shortcuts .settings-nav-item')].map(e=>e.textContent.trim());return b.at(-1)==='Server' && b.at(-2).startsWith('Connectors')})()");
    await check('Server leads the page', "document.querySelector('[data-settings-group]')?.dataset.settingsGroup==='server'");
    await check('status and switch in the header', "(()=>{const s=document.querySelector('[data-agent-server-status]');return !!s && s.innerText.includes('Running') && !!s.querySelector('[role=switch],button')})()");
    await check('Configure starts closed', "document.querySelector('[data-agent-server-configure]')?.getAttribute('aria-expanded')==='false'");
    await capture('settings-server-collapsed');
    await run("document.querySelector('[data-agent-server-configure]').click()"); await sleep(600);
    await check('Configure opens the details', "document.querySelector('[data-agent-server-configure]').getAttribute('aria-expanded')==='true' && document.querySelector('#agent-server-configure').innerText.includes('MCP clients')");
    await capture('settings-server-configure-open');
    // The wheel over the side menu scrolls the page.
    const before = await run("document.querySelector('.settings-content').scrollTop");
    win.webContents.sendInputEvent({ type: 'mouseWheel', x: 100, y: 700, deltaX: 0, deltaY: -600 });
    await sleep(400);
    await check('wheel over the side menu scrolls the content', `document.querySelector('.settings-content').scrollTop > ${before}`);
  } catch (e) { report.errors.push(String(e && e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ checks: report.checks, errors: report.errors, blockedNetwork: report.blockedNetwork.length }, null, 2));
  app.exit(report.checks.some(c => !c.passed) || report.errors.length ? 1 : 0);
});
