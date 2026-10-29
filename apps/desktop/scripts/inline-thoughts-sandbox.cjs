// Real ActivityGroup with synthetic public thought text only. Hidden, isolated,
// network-blocked; launched by tool-groups-integration.cjs.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_COMPONENT_OUT;
if (!out) throw Error('Launch through tool-groups-integration.cjs');
const before = !!process.env.NEKKO_TEST_REVISION;
const dir = path.join(out, before ? 'thoughts-before' : 'thoughts-after');
fs.mkdirSync(dir, { recursive: true });
app.setPath('userData', path.join(dir, 'profile'));
app.setPath('sessionData', path.join(dir, 'profile'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((request, done) => done({ cancel: !/^(file:|data:|blob:)/.test(request.url) }));
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, done) => done(false));
  const win = new BrowserWindow({ width: 1000, height: 1050, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -10000, y: -10000, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  const report = { checks: [], errors: [] };
  win.on('show', () => report.errors.push('Window became visible'));
  win.on('focus', () => report.errors.push('Window took focus'));
  win.webContents.on('console-message', event => { if (event.level === 'error') report.errors.push(event.message); });
  const run = code => win.webContents.executeJavaScript(code, true);
  const capture = async name => fs.writeFileSync(path.join(dir, name + '.png'), (await win.capturePage(undefined, { stayHidden: true })).toPNG());
  try {
    await win.loadFile(path.join(out, 'index.html'));
    await sleep(800);
    await run("document.documentElement.dataset.theme='dark'");
    for (const width of [1000, 390]) {
      win.setContentSize(width, 1050); await sleep(300);
      await capture(`thoughts-${width}`);
      if (!before) {
        const state = await run(`(() => {
          const thoughts = [...document.querySelectorAll('[data-scene=turn] [data-chat-thought]')];
          return { count: thoughts.length, visible: thoughts.every(e => e.getBoundingClientRect().height > 20 && !!e.querySelector('svg')), overflow: document.documentElement.scrollWidth > innerWidth };
        })()`);
        if (state.count !== 2 || !state.visible || state.overflow) throw Error('Thought layout failed: ' + JSON.stringify(state));
        await run("document.querySelector('[data-scene=turn] button').click()");
        await sleep(150);
        if (!await run("document.querySelectorAll('[data-scene=turn] [data-chat-thought]').length === 2")) throw Error('Tool disclosure hid thoughts');
        await run("document.querySelector('[data-scene=turn] button').click()");
        report.checks.push(`${width}px: two visible icon-prefixed thoughts, no overflow, unaffected by tool disclosure`);
      }
    }
    win.setContentSize(1000, 1050); await sleep(150);
    if (!before) {
      if (!await run("document.querySelectorAll('[data-scene=live] [data-chat-thought]').length === 1")) throw Error('Live thought missing');
      await run('window.__advance()'); await sleep(200);
      if (!await run("document.querySelectorAll('[data-scene=live] [data-chat-thought]').length === 1")) throw Error('Live thought duplicated or removed by tool event');
      report.checks.push('Live thought stays visible when a tool arrives');
    }
    report.background = { visible: win.isVisible(), focused: win.isFocused(), bounds: win.getBounds() };
    report.success = !report.errors.length;
  } catch (error) { report.errors.push(String(error)); report.success = false; }
  finally {
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    win.destroy(); app.exit(report.success ? 0 : 1);
  }
});
