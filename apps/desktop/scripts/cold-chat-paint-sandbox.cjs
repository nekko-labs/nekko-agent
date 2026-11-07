// Synthetic six-zone cold-switch evidence. Launch with layout-evidence-integration.cjs.
// No daemon, network, credentials or visible/focusable window.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
app.setPath('sessionData', path.join(out, 'profile'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((request, done) => done({ cancel: !/^(file:|data:|blob:)/.test(request.url) }));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, title: 'Cold-chat paint verification', webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const report = { checks: [], failed: [], captures: [], errors: [], inspected: false };
  win.on('focus', () => report.errors.push('Fixture took focus'));
  const run = source => win.webContents.executeJavaScript(source, true);
  const check = async (name, source) => (await run(source) ? report.checks : report.failed).push(name);
  const shot = async name => {
    const file = path.join(out, `${name}.png`);
    fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG());
    report.captures.push(file);
  };
  const card = id => `([...document.querySelectorAll('div[role="button"]')].find(e => e.title?.includes(${JSON.stringify(`Synthetic chat ${id}`)}))).click()`;
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 100 && !(await run('!!window.integration?.state().sessions.length')); i++) await sleep(100);
    await run(`(async () => {
      const records = integration.records(), original = records[0], summary = integration.state().sessions[0];
      records.splice(0, records.length, ...Array.from({ length: 10 }, (_, i) => ({ ...original, id: 'cold-' + i, title: 'Synthetic chat ' + i,
        createdAt: 1700000000000, updatedAt: 1700000000000 + i,
        messages: Array.from({ length: 400 }, (_, n) => ({ id: i + '-' + n, role: n % 2 ? 'assistant' : 'user', content: 'Chat ' + i + ', message ' + n + '. **Synthetic** transcript with a [reference](https://example.invalid/).', createdAt: 1700000000000 + n })) })));
      integration.state();
      const wall = { ...integration.state().settings.commandWall, layout: { mode: 'focus', cols: 3, rows: 2 }, zones: true, activeZone: 'zone-0', hero: 'cold-0', zonesIntro: true, watermark: 1700000000000,
        root: { id: 'root', dir: 'col', sizes: [.5, .5], children: [0, 1].map(r => ({ id: 'row-' + r, dir: 'row', sizes: [1/3,1/3,1/3], children: [0,1,2].map(c => ({ id: 'zone-' + (r*3+c), kind: 'chat', refId: 'cold-' + (r*3+c) })) })) } };
      await integration.configureWall(wall);
      // A refresh reads summaries through the synthetic bridge.
      await integration.state().refreshSessions();
      document.documentElement.dataset.theme = 'dark';
      localStorage.setItem('nekko.chatMode', 'simple');
    })()`);
    await sleep(1000);
    await run(card(6)); await sleep(700);
    await check('off-board chat replaces the active zone', `document.querySelector('[data-wall-hero] [data-chat-surface]')?.dataset.sessionId === 'cold-6'`);
    await check('six board windows remain', `document.querySelectorAll('[data-grid-cell^="chat:"]').length === 6`);
    await check('newest message is rendered', `document.querySelector('[data-wall-hero]')?.textContent.includes('Chat 6, message 399')`);
    await shot('focused-1440');
    // A cold replacement must not inherit an outgoing draft or its editor DOM.
    await run(`(() => { const editor = document.querySelector('[data-wall-hero] [contenteditable]'); window.outgoingEditor = editor; editor.textContent = 'Unsent draft for chat 6'; editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '6' })); })()`);
    await run(card(7)); await sleep(700);
    await check('replacement has a separate editor and draft', `(() => { const editor = document.querySelector('[data-wall-hero] [contenteditable]'); return editor && editor !== outgoingEditor && editor.textContent === ''; })()`);
    await run(card(6)); await sleep(700);
    await check('outgoing draft survives remount', `document.querySelector('[data-wall-hero] [contenteditable]')?.textContent === 'Unsent draft for chat 6'`);
    // Capture a cold switch as frames for the timing handoff (not latency data).
    fs.mkdirSync(path.join(out, 'motion'), { recursive: true });
    await run(card(8));
    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(path.join(out, 'motion', `${String(i).padStart(3, '0')}.png`), (await win.capturePage(undefined, { stayHidden: true })).toPNG());
      await sleep(25);
    }
    win.setContentSize(400, 900); await sleep(700);
    await shot('focused-400');
    await check('narrow transcript and composer fit the viewport', `(() => { const pane = document.querySelector('[data-wall-hero] [data-chat-surface]'), editor = pane?.querySelector('[contenteditable]'); const b = editor?.getBoundingClientRect(); return !!b && b.width > 0 && b.left >= 0 && b.right <= innerWidth + 1; })()`);
    report.window = { visible: win.isVisible(), focused: win.isFocused(), bounds: win.getBounds() };
    if (win.isVisible() || win.isFocused()) report.errors.push('Fixture visibility invariant failed');
  } catch (e) { report.errors.push(String(e.stack || e)); }
  report.success = !report.failed.length && !report.errors.length;
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  win.destroy(); app.exit(report.success ? 0 : 1);
});
