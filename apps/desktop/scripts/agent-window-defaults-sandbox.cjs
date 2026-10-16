const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
const tag = process.env.NEKKO_TEST_REVISION ? 'before' : 'after';
const dir = path.join(out, `${tag}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
fs.mkdirSync(dir, { recursive: true });
app.setPath('userData', path.join(dir, 'profile'));
app.setPath('sessionData', path.join(dir, 'profile'));
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('disable-background-networking');
const report = { revision: process.env.NEKKO_TEST_REVISION || 'working-tree', checks: [], captures: [], errors: [], blockedRequests: [], visuallyInspected: false };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => {
    const cancel = !/^(file:|data:|blob:)/.test(details.url);
    if (cancel) report.blockedRequests.push(details.url);
    done({ cancel });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, done) => done(false));
  const win = new BrowserWindow({ width: 1200, height: 800, useContentSize: true, show: false, focusable: false, skipTaskbar: true, title: 'Owned hidden agent window defaults fixture', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('Unexpected OS focus'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('console-message', event => { if (event.level === 'error') report.errors.push(event.message); });
  const run = source => win.webContents.executeJavaScript(source, true);
  const button = text => `[...document.querySelectorAll('button')].find(b=>b.textContent.trim().startsWith(${JSON.stringify(text)}))`;
  const click = async source => { await run(`(()=>{const b=${source};if(!b)throw Error('Missing button');b.click()})()`); await sleep(180); };
  const check = async (name, source, expected = true) => {
    await sleep(100);
    const actual = await run(source);
    report.checks.push({ name, actual, expected, passed: actual === expected });
    if (actual !== expected) throw Error(`${name}: expected ${expected}, got ${actual}`);
  };
  const observe = async (name, source) => {
    const actual = await run(source);
    // Baseline failures are evidence of the bug, not waived after assertions.
    const expected = tag === 'after';
    report.checks.push({ name, actual, expected, passed: actual === expected, baselineObservation: tag === 'before' });
    if (actual !== expected) throw Error(`${name}: expected ${expected}, got ${actual}`);
  };
  const capture = async name => {
    await sleep(250);
    const image = await win.capturePage(undefined, { stayHidden: true, stayAwake: false });
    if (image.isEmpty()) throw Error('Empty capture');
    const file = path.join(dir, `${tag}-${name}.png`);
    fs.writeFileSync(file, image.toPNG());
    report.captures.push({ path: file, size: image.getSize(), theme: await run('document.documentElement.dataset.theme'), viewport: await run('({width:innerWidth,height:innerHeight})') });
  };
  const mode = () => click(button('Mode'));
  const chat = () => click("document.querySelector('.agent-window-picker__categories button')");
  const save = async () => {
    report.calls = await run('integration.calls');
    report.settings = await run('integration.settings()');
    report.record = await run('integration.record()');
    report.ownedPids = app.getAppMetrics().map(metric => metric.pid);
    report.pid = process.pid; report.hidden = !win.isVisible(); report.focusable = win.isFocusable();
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(out, `${tag}-latest.txt`), dir);
  };
  try {
    await win.loadFile(path.join(out, 'index.html')); await sleep(650);
    await check('actual AgentWindowPicker mounted', "!!document.querySelector('[aria-label=\"Add agent window\"]')");
    await chat();
    await click("document.querySelector('.agent-window-picker__summary')");
    await click(button('Fixture beta'));
    await check('actual model picker shows explicit selection', "document.querySelector('.agent-window-picker__summary').textContent.includes('Fixture beta')");
    await click("document.querySelector('[aria-label=\"Close window picker\"]')");
    await run('integration.remount()'); await sleep(150); await chat();
    await observe('model choice saved and used after close/reopen', "integration.settings().defaultModelId==='fixture-beta'&&document.querySelector('.agent-window-picker__summary').textContent.includes('Fixture beta')");
    await run(`(()=>{const input=document.querySelector('input[aria-label="Reasoning effort"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'2');input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await sleep(180);
    await check('effort saved through settings API', "integration.settings().effort==='high'&&integration.calls.some(c=>c.api==='updateSettings'&&c.patch.effort==='high')");
    await run('integration.remount()'); await sleep(150); await chat();
    await check('effort survives actual picker remount', "document.querySelector('input[aria-label=\"Reasoning effort\"]').value==='2'");
    await mode(); await click(button('Ask'));
    await check('permission selection updates original session', "integration.record().mode==='ask'");
    await observe('permission selection saves app default', "integration.settings().defaultChatMode==='ask'&&integration.calls.some(c=>c.api==='updateSettings'&&c.patch.defaultChatMode==='ask')");
    await run('integration.newSession()'); await sleep(150); await chat();
    await check('new synthetic record has no explicit permission override', "integration.record().mode===undefined");
    await mode();
    await observe('newly constructed session uses saved permission mode', "document.querySelector('[data-chat-mode=ask]').getAttribute('aria-checked')==='true'");
    await click(button('Unified'));
    await check('execution selection saves app default', "integration.settings().defaultExecutionMode==='unified'&&integration.record().executionMode==='unified'");
    await run('integration.newSession()'); await sleep(150); await chat();
    await check('execution default survives new session and remount', "integration.record().executionMode==='unified'&&integration.record().gitIsolation===false&&[...document.querySelectorAll('button')].some(b=>b.textContent.startsWith('Mode')&&b.textContent.includes('Unified'))");
    await click(button('Start'));
    await observe('reopened picker Start uses saved model pair', "integration.calls.filter(c=>c.api==='onAdd').at(-1).selection.modelId==='fixture-beta'&&integration.calls.filter(c=>c.api==='onAdd').at(-1).selection.providerId==='synthetic'");
    await run('integration.remount()'); await sleep(150); await chat();
    for (const theme of ['light', 'dark']) for (const width of [1200, 390]) {
      win.setContentSize(width, 800); await run(`integration.theme('${theme}')`);
      await capture(`picker-${theme}-${width}`);
      await mode(); await capture(`mode-${theme}-${width}`);
      await check(`mode menu within ${theme} ${width} viewport`, "(()=>{const r=document.querySelector('[aria-label=\"Chat mode\"]').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1})()");
      await mode();
    }
    await check('window remains hidden and non-focusable', `${!win.isVisible() && !win.isFocusable()}`);
    await check('no network requests attempted', `${report.blockedRequests.length === 0}`);
    if (report.errors.length) throw Error(report.errors.join('\n'));
    await save(); console.log(JSON.stringify({ dir, checks: report.checks.length, captures: report.captures.length }));
  } catch (error) {
    report.errors.push(String(error.stack || error));
    await save(); console.error(error); process.exitCode = 1;
  } finally { win.destroy(); app.quit(); }
}).catch(error => { console.error(error); process.exitCode = 1; app.quit(); });
