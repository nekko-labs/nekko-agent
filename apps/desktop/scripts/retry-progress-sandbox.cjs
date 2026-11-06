// Full ChatPane with synthetic events. No host, network, OS input or user data.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Use layout-evidence-integration.cjs');
const before = process.env.NEKKO_BEFORE === '1';
app.setPath('userData', path.join(out, 'profile'));
app.setPath('sessionData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ title: 'Retry progress isolated verification', width: 1280, height: 1000, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -10000, y: -10000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const report = { checks: [], errors: [], captures: [] };
  win.on('show', () => report.errors.push('Window shown'));
  win.on('focus', () => report.errors.push('Window focused'));
  const run = code => win.webContents.executeJavaScript(code, true);
  const check = async (code, label) => { if (!await run(code)) throw Error(label); report.checks.push(label); };
  const frames = [];
  const capture = async name => {
    const image = await win.capturePage(undefined, { stayHidden: true });
    const file = path.join(out, name + '.png'); fs.writeFileSync(file, image.toPNG()); report.captures.push(file);
    frames.push(image.resize({ width: 900 }).toPNG());
  };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    await win.webContents.insertCSS('.fade-in { animation: none !important; opacity: 1 !important; }');
    for (let n = 0; n < 60 && !await run('!!window.layoutFixture'); n++) await sleep(100);
    await run('layoutFixture.showRetry()'); await sleep(700);
    await check(`document.body.innerText.includes('Completed the first step before interruption.')`, 'Interrupted work visible before retry');
    await run(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Retry').click()`); await sleep(400);
    await check(`layoutFixture.lastSend?.resume === true && layoutFixture.lastSend.text === ''`, 'Retry sends resume without another user prompt');
    if (!before) await check(`document.body.innerText.includes('Completed the first step before interruption.')`, 'Retry retains interrupted work before the first token');
    await capture('retry-1280');
    await run(`layoutFixture.emit({type:'reasoning',delta:'First inspect the project guidance.'})`); await sleep(200);
    await check(`document.querySelector('[data-chat-thought]')?.textContent.includes('First inspect')`, 'First thought expands on its first event');
    await capture('first-thought-1280');
    for (const [id, name] of [['c1','AGENTS.md'],['c2','CLAUDE.md']]) {
      await run(`layoutFixture.emit({type:'tool_call',call:{id:'${id}',name:'read_file',input:{path:'${name}'}}})`); await sleep(120);
      await run(`layoutFixture.emit({type:'tool_result',result:{toolCallId:'${id}',output:'Synthetic guidance'}})`); await sleep(120);
    }
    await check(`!!document.querySelector('[data-purpose-group="guidance"]')`, 'Purpose grouping exists while the turn is still running');
    await capture('grouped-live-1280');
    await run(`layoutFixture.emit({type:'reasoning',delta:'Now inspect the source code.'})`); await sleep(250);
    await check(`document.querySelectorAll('[data-chat-thought]').length === 2`, 'Second thought expands immediately without hiding the first');
    if (!before) await check(`document.querySelector('[data-chat-thought] + div button')?.getAttribute('aria-expanded') === 'false'`, 'Previous tool phase folds as the next thought arrives');
    await capture('next-thought-1280');
    win.setContentSize(460, 1000); await sleep(500);
    await check(`document.documentElement.scrollWidth <= innerWidth`, 'No page overflow at mobile width');
    await capture('next-thought-460');
    if (!before) {
      await run(`document.querySelector('[data-chat-thought] + div button').click()`);
      await run(`layoutFixture.emit({type:'text',delta:'Guidance checked; continue implementation.'})`); await sleep(200);
      await check(`document.querySelector('[data-chat-thought] + div button')?.getAttribute('aria-expanded') === 'true'`, 'Explicit disclosure choice survives later progress');
      await run('layoutFixture.showGreeting()'); await sleep(200);
      await run('layoutFixture.showRetry()'); await sleep(400);
      await check(`document.body.innerText.includes('Completed the first step before interruption.') && document.querySelectorAll('[data-chat-thought]').length === 2`, 'Remount keeps saved work and live progress without another event');
    }
    require('./evidence-gif.cjs')(path.join(out, 'progress.gif'), frames.slice(0, 4), 90);
    report.background = { visible: win.isVisible(), focused: win.isFocused(), bounds: win.getBounds() };
    if (win.isVisible() || win.isFocused()) throw Error('Isolation failed');
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  win.destroy(); app.exit(report.errors.length ? 1 : 0);
});
