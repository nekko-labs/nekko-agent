// Full-App Library journey for #3045: a chat hands a design to a helper agent, which writes it in a git
// worktree that is removed once the branch merges; the chat only searches and reads the design, and its
// reply names it relatively from a folder that holds many repos. Synthetic bridge, isolated profile, no
// network or OS input. NEKKO_LIBRARY_BASELINE=1 captures the same data on an unchanged checkout (via
// NEKKO_TEST_SOURCE) without the checks.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const baseline = process.env.NEKKO_LIBRARY_BASELINE === '1';
const js = (v) => JSON.stringify(v).replace(/[<>/\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { checks: {}, errors: [], captures: [], listed: [] };

// The chat folder is /code, a parent of repos. The worktree /code/floop/.worktrees/board-drag is gone; its design lives on in the repo.
const TREE = '/code/floop/.worktrees/board-drag';
const DISK = {
  '/code': [{ name: 'floop', path: '/code/floop', dir: true }, { name: 'node_modules', path: '/code/node_modules', dir: true }, { name: 'notes.txt', path: '/code/notes.txt', dir: false }],
  '/code/floop': [{ name: 'nekko-designs', path: '/code/floop/nekko-designs', dir: true }, { name: 'apps', path: '/code/floop/apps', dir: true }],
  '/code/floop/nekko-designs': [
    { name: 'task-details-design.html', path: '/code/floop/nekko-designs/task-details-design.html', dir: false },
    { name: 'task-details-design.png', path: '/code/floop/nekko-designs/task-details-design.png', dir: false },
  ],
};
const tool = (name, input) => ({ id: name + JSON.stringify(input), name, input, executedBy: 'claude-code' });
const PARENT = { title: 'Floop board and task page', messages: [
  { role: 'user', content: 'Make the board draggable, and design a cleaner task page.' },
  { role: 'assistant', content: '', toolCalls: [tool('spawn_agent', { description: 'Design reworked task details view', prompt: 'Design it.' })] },
  { role: 'assistant', content: '', toolCalls: [tool('Read', { file_path: `${TREE}/nekko-designs/task-details-design.png` }), tool('Grep', { pattern: 'x', path: `${TREE}/nekko-designs/task-details-design.html` })] },
  { role: 'assistant', content: 'Merged. The task page design is at `nekko-designs/task-details-design.html`, with a PNG next to it.' },
] };
const HELPER = { title: 'Design reworked task details view', messages: [
  { role: 'user', content: 'Design it.' },
  { role: 'assistant', content: 'Done.', toolCalls: [tool('Write', { file_path: `${TREE}/nekko-designs/task-details-design.html`, content: '<!doctype html>' }), tool('Write', { file_path: `${TREE}/nekko-designs/screenshot.mjs`, content: '' })] },
] };

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  win.on('focus', () => report.errors.push('Window took focus'));
  const run = source => win.webContents.executeJavaScript(source);
  const check = async (source, label) => { if (baseline) return; const ok = await run(source); report.checks[label] = ok; if (!ok) throw Error(label); };
  const shot = async name => { const file = path.join(out, `${name}.png`); fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(file); };
  const rows = `[...document.querySelectorAll('[data-artifact-row]')].map(r => r.querySelector('span span').textContent + ' | ' + r.title)`;
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 80 && !await run('!!window.layoutFixture'); i++) await sleep(100);
    await sleep(500);
    await run(`(() => {
      document.querySelector('.zones-intro button[aria-label="Close"]')?.click();
      localStorage.setItem('nekko.libraryIntroSeen', '1');
      localStorage.removeItem('nekko.libraryLayout'); localStorage.removeItem('nekko.libraryCollapsed');
      const f = layoutFixture, chats = [${js(PARENT)}, ${js(HELPER)}], disk = ${js(DISK)}, now = Date.now();
      f.records.slice(0, 2).forEach((s, n) => {
        s.title = chats[n].title; s.workspaceId = 'w1';
        if (n === 1) s.parentSessionId = f.records[0].id;
        s.messages = chats[n].messages.map((m, i) => ({ id: s.id + i, createdAt: now - 60000 * (9 - i), ...m }));
        s.updatedAt = now - n; f.putCachedSession(s);
      });
      f.listed = [];
      f.bridge.listDir = async (p) => { f.listed.push(p); return disk[p] ?? []; };
      f.bridge.listComments = async () => [];
      f.bridge.readFile = async (p) => { if (!/^\\/code\\/floop\\/nekko-designs\\//.test(p)) throw new Error('ENOENT: ' + p); return { content: '<!doctype html><title>Task details</title><body style="font:16px system-ui;padding:32px;background:#f4f1ea"><h1>Task details</h1><p>Synthetic design for Library verification.</p></body>', truncated: false, binary: false }; };
      f.bridge.openPath = async p => { f.lastOpenPath = p; };
      f.store.setState({ settings: { ...f.store.getState().settings, theme: 'dark', workProfile: 'designer', workspaces: [{ id: 'w1', name: 'code', path: '/code', addedAt: now }] } }); f.store.getState().applyTheme();
      f.store.getState().refreshSessions();
      f.store.getState().setView('artifacts');
    })()`);
    await sleep(1500);
    win.setContentSize(1440, 900); await sleep(400);
    await shot('library-moved-designs');
    report.rows = await run(rows);
    report.listed = await run('[...new Set(layoutFixture.listed)].sort()');
    const design = `[...document.querySelectorAll('[data-artifact-kind="design"] [data-artifact-row]')]`;
    await check(`${design}.length === 2`, 'both-designs-listed');
    await check(`${design}.every(r => r.title.startsWith('/code/floop/nekko-designs/'))`, 'listed-at-the-main-checkout');
    await check(`${design}.every(r => r.textContent.includes(${js(PARENT.title)}))`, 'listed-under-the-chat-that-started-the-helper');
    await check(`!document.querySelector('[data-artifact-row][title*="screenshot.mjs"]') && !document.querySelector('[data-artifact-row][title*=".worktrees"]')`, 'no-script-and-no-dead-worktree-path');
    if (!baseline) {
      await run(`${design}.find(r => r.title.endsWith('.html')).click()`); await sleep(900);
      await shot('library-moved-design-open');
      await check(`(() => { const bar = document.querySelector('[data-library-back]').parentElement; return /Open chat/.test(bar.textContent) && bar.textContent.includes('/code/floop/nekko-designs/task-details-design.html'); })()`, 'opens-from-the-repo-with-its-chat');
    }
    if (report.errors.length) throw Error('Renderer errors: ' + report.errors.join('; '));
    report.background = { visible: win.isVisible(), focusable: win.isFocusable(), bounds: win.getBounds() };
    if (report.background.visible || report.background.focusable) throw Error('Unsafe fixture window');
  } catch (error) { report.failure = String(error.stack || error); process.exitCode = 1; }
  finally { fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); win.destroy(); app.exit(process.exitCode || 0); }
});
