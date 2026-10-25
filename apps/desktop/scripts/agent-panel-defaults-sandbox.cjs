// Agents panel evidence: one agent waiting on you, one working, one idle, in
// both themes, plus the view menu's Show submenu. Hidden, off-screen,
// non-focusable. Launch through layout-evidence-integration.cjs with
// NEKKO_LAYOUT_SANDBOX=agent-attention-sandbox.cjs.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], errors: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const minX = Math.min(...screen.getAllDisplays().map(d => d.bounds.x)), minY = Math.min(...screen.getAllDisplays().map(d => d.bounds.y));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: minX - 1700, y: minY - 1100, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => { report.errors.push('took focus'); });
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const shot = async (name, rect) => { const f = path.join(out, name + '.png'); fs.writeFileSync(f, (await win.capturePage(rect, { stayHidden: true, stayAwake: false })).toPNG()); report.captures.push(f); };
  const ready = async () => { for (let i = 0; i < 50 && !(await run("!!document.querySelector('[title=\"View options: group, sort and show\"]')")); i++) await sleep(200); await sleep(900); };
  const crop = { x: 0, y: 0, width: 520, height: 420 };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    await ready();
    await shot('empty-utilities');
    const seed = `(() => {
      const store = layoutFixture.store;
      const s = store.getState();
      const media = { ...s.sessions[0], id: 'media-fixture', title: 'Photo project', chatType: 'image' };
      const terminal = { id: 'terminal-fixture', title: 'Build shell', createdAt: 1, shell: '/bin/zsh', cwd: '/fixture', running: true };
      store.setState({ sessions: [...s.sessions, media], terminals: [terminal], workspaces: [...s.workspaces, { id: 'terminal-window', anchor: { kind: 'terminal', refId: terminal.id }, root: { id: 'terminal-pane', kind: 'terminal', refId: terminal.id }, activePaneId: 'terminal-pane' }] });
    })()`;
    await run(seed); await sleep(600);
    await shot('populated-utilities');
    report.groups = await run("Array.from(document.querySelectorAll('[data-agent-group]')).map(e => e.getAttribute('data-agent-group'))");
    await run(`(() => {
      const store = layoutFixture.store;
      window.creationCalls = [];
      window.nekko.createSession = async () => { window.creationCalls.push('chat'); return { id: 'fixture-chat', title: 'New chat', messages: [], attachments: [], queuedPrompts: [], createdAt: 1, updatedAt: 1 }; }; window.nekko.createTerminal = async () => { window.creationCalls.push('terminal'); return { id: 'fixture-terminal' }; };
      document.querySelector('.agent-panel-plus').click();
    })()`);
    await sleep(500);
    report.creationCalls = await run('window.creationCalls');
    report.hasRedundantCopy = await run("document.body.innerText.includes('Describe the task. The full chat opens once you send.')");
    report.brandIsSvg = await run("!!document.querySelector('.titlebar-mark svg path')");
    report.hidden = !win.isVisible();
    if (report.groups.join(',') !== '__terminals,__media,__none') throw Error('Unexpected utility grouping');
    if (report.creationCalls.join(',') !== 'chat') throw Error('Plus must create a chat');
    if (report.hasRedundantCopy || !report.hidden) throw Error('Copy or isolation regression');
  } catch (e) { report.errors.push(String(e && e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.creationCalls?.join(',') === 'chat' && report.groups?.[0] === '__terminals' ? 0 : 1);
});
