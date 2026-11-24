// The phone-style model chip (effort gauge + name, one menu with an Effort section) and the folder on the
// bottom row. Expert mode, one wall window on a model that advertises effort, captured hidden and off-screen.
//   NEKKO_LAYOUT_SANDBOX=model-effort-sandbox.cjs node apps/desktop/scripts/layout-evidence-integration.cjs
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
app.disableHardwareAcceleration();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const js = v => JSON.stringify(v).replace(/[<>/\u2028\u2029]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const report = { checks: {}, captures: [], errors: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1100, height: 800, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -10000, y: -10000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const run = code => win.webContents.executeJavaScript(code, true);
  const rect = sel => run(`(() => { const e = document.querySelector(${js(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) }; })()`);
  const shot = async (name, r) => {
    const file = path.join(out, name + '.png');
    fs.writeFileSync(file, (await win.capturePage(r || undefined, { stayHidden: true })).toPNG());
    report.captures.push(file);
  };
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 200)); });
  win.on('show', () => report.errors.push('Window became visible'));
  win.on('focus', () => report.errors.push('Window took focus'));
  try {
    await win.loadURL('about:blank');
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Page.enable');
    await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('nekko.chatMode', 'expert'); localStorage.setItem('nekko.commandWall', JSON.stringify({root:{id:'a-pane',kind:'chat',refId:'a'},hero:'a',watermark:1,autoAdd:false,layout:{mode:'grid'},dock:{show:false},agentPanel:{show:false},zones:true,zonesIntro:true,activeZone:'a-pane'}));` });
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 80 && !await run('!!window.layoutFixture && !!document.querySelector("[data-chat-surface]")'); i++) await sleep(100);
    await run(`(() => {
      const f = layoutFixture, st = f.store, a = f.records[0];
      const effort = { levels: ['low', 'medium', 'high', 'xhigh', 'max'].map((e) => ({ effort: e, description: e === 'high' ? 'Greater reasoning depth for complex problems' : undefined })), default: 'medium' };
      const selected = { id: a.modelId, providerId: a.providerId, name: 'GPT fixture', effort };
      const catalog = [selected, ...Array.from({ length: 24 }, (_, i) => ({ ...selected, id: 'gpt-fixture-' + i, name: 'GPT fixture ' + (i + 1) }))];
      f.bridge.listModels = async () => catalog;
      st.setState({ models: catalog });
      f.bridge.setSessionOptions = async (id, patch) => {
        if (id !== a.id) throw Error('Unexpected chat: ' + id);
        Object.assign(a, patch);
        return { ...a };
      };
      Object.assign(a, { effort: 'high', executionMode: 'worktree', gitIsolation: true });
      f.putCachedSession(a);
    })()`);
    await run(`layoutFixture.store.getState().refreshSessions()`);
    await sleep(1500);
    await shot('composer', await rect('.composer'));
    report.checks.gaugeInChip = await run(`!!document.querySelector('button[aria-haspopup="listbox"] [data-effort-gauge]')`);
    report.checks.standaloneEffort = await run(`document.querySelectorAll('.effort-trigger').length`);
    report.checks.folderOnBottomRow = await run(`!!document.querySelector('[data-composer-mode-row] > .composer-folders') && !document.querySelector('.composer-bar .composer-folders')`);
    await run(`document.querySelector('button[aria-haspopup="listbox"]').click()`);
    const slider = '[data-effort-section] input[type="range"]';
    const select = (s) => `document.querySelector(${js(s)})`;
    for (const [name, width] of [['desktop', 1100], ['narrow', 360]]) {
      win.setContentSize(width, 800);
      await sleep(700);
      const menu = await rect('[data-model-picker]');
      const section = await rect('[data-effort-section]');
      const list = await rect('[data-model-picker] [role="listbox"]');
      assert.ok(menu && section && list, 'The model menu shows the list and effort section');
      assert.equal(await run('window.innerWidth'), width, 'The fixture uses the requested viewport');
      assert.equal(await run(`${select(slider)}?.getAttribute('aria-valuetext')`), 'High');
      report.checks[name] = { width, menu, section, list, effortCopy: await run(`${select('[data-effort-section]')}.textContent`) };
      await shot('model-menu-' + name, menu);
    }
    // Real keyboard input to the hidden renderer, not a synthetic change event.
    await run(`${select(slider)}.focus()`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' });
    await sleep(300);
    report.checks.selectedEffort = await run(`({ value: ${select(slider)}.getAttribute('aria-valuetext'), chat: layoutFixture.records[0].effort, gauge: ${select('[data-effort-gauge]')}.dataset.effortIndex })`);
    assert.deepEqual(report.checks.selectedEffort, { value: 'Extra high', chat: 'xhigh', gauge: '3' });
    assert.equal(win.isVisible() || win.isFocused(), false, 'The fixture remains hidden and non-focusable');
    assert.deepEqual(report.errors, []);
  } catch (e) {
    report.errors.push(String(e && e.stack || e));
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ checks: report.checks, errors: report.errors.slice(0, 5), captures: report.captures.length }));
    app.exit(process.exitCode || 0);
  }
});
