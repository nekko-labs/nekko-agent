const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const dir = process.env.NEKKO_EVIDENCE_DIR, kind = process.env.NEKKO_EVIDENCE_KIND;
const profile = fs.mkdtempSync(path.join(dir, 'profile-'));
app.setPath('userData', profile); app.setPath('sessionData', profile);
const report = { kind, checks: [], errors: [], captures: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((r, done) => done({ cancel: !/^(file:|data:|blob:)/.test(r.url) }));
  session.defaultSession.setPermissionRequestHandler((w, p, d) => d(false));
  const left = Math.min(...screen.getAllDisplays().map((d) => d.bounds.x));
  const win = new BrowserWindow({ width: 1400, height: 820, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: left - 5000, y: -3000, webPreferences: { contextIsolation: true, sandbox: true } });
  win.on('focus', () => report.errors.push('OS focus taken'));
  win.webContents.on('console-message', (e) => { if (e.level === 'error') report.errors.push(e.message); });
  const run = (s) => win.webContents.executeJavaScript(s, true);
  const settle = async () => { await run('document.fonts.ready'); await sleep(350); };
  const capture = async (name) => { await settle(); const img = await win.capturePage(undefined, { stayHidden: true }); const file = path.join(dir, name + '.png'); fs.writeFileSync(file, img.toPNG()); report.captures.push(file); };
  const check = async (name, s) => { try { report.checks.push({ name, passed: !!(await run(s)) }); } catch (e) { report.checks.push({ name, passed: false, error: String(e) }); } };
  const click = (sel) => run(`document.querySelector(${JSON.stringify(sel)}).click()`);
  const inView = (sel) => `(()=>{const r=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()`;
  try {
    await win.loadFile(path.join(dir, 'index.html')); win.showInactive(); await settle();
    for (const theme of ['dark', 'light']) {
      await run(`document.documentElement.dataset.theme='${theme}'`);
      await click('.ctl-menu'); await settle();
      if (kind === 'before') {
        await capture(`${kind}-panel-${theme}`);
        await click('[data-mode-fly="mcp"]'); await settle();
        await capture(`${kind}-mcp-${theme}`);
        await click('[data-mode-fly="mcp"]'); await settle();
        await run(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`); await settle(); continue;
      }
      await check(theme + ' panel open', `!!document.querySelector('.mode-panel')`);
      await check(theme + ' panel inside viewport', inView('.mode-panel'));
      await check(theme + ' four sections', `['Environment','Model','Privacy','Approach'].every((t)=>document.querySelector('.mode-panel').innerText.toUpperCase().includes(t.toUpperCase()))`);
      await check(theme + ' an unsaved combination reads Custom', `document.querySelector('.mode-head h2').innerText.startsWith('Custom')`);
      await capture(`${kind}-panel-${theme}`);
      await click('[data-mode-fly="tools"]'); await settle();
      await check(theme + ' tools flyout beside panel', `(()=>{const f=document.querySelector('.mode-fly').getBoundingClientRect(),p=document.querySelector('.mode-panel').getBoundingClientRect();return f.left>=p.right-1||f.right<=p.left+1||f.left>=document.querySelector('[data-mode-fly=tools]').getBoundingClientRect().right-1})()`);
      await check(theme + ' tools flyout inside viewport', inView('.mode-fly'));
      await capture(`${kind}-tools-${theme}`);
      await click('[data-mode-fly="skills"]'); await settle();
      await capture(`${kind}-skills-${theme}`);
      await click('[data-mode-fly="skills"]'); await settle();
      await click('[data-mode-fly="mcp"]'); await settle();
      await check(theme + ' MCP flyout lists per-chat switches', `document.querySelectorAll('.mode-fly [data-chat-mcp]').length===3`);
      await check(theme + ' a server off in Settings is not switchable', `document.querySelector('[data-chat-mcp="hypergate"] .mode-switch').disabled`);
      await click('[data-chat-mcp="context7"] .mode-switch'); await settle();
      await check(theme + ' switching a server off writes the chat only', `JSON.stringify(evidence.calls.at(-1))==='{"id":"fixture","patch":{"disabledMcpServers":["context7"]}}'`);
      await check(theme + ' MCP row counts this chat', `document.querySelector('[data-mode-fly="mcp"]').innerText.includes('1 of 3 on')`);
      await capture(`${kind}-mcp-${theme}`);
      await click('[data-chat-mcp="context7"] .mode-switch'); await settle();
      await click('[data-mode-fly="connectors"]'); await settle();
      await check(theme + ' connectors flyout lists connected ones only', `document.querySelectorAll('.mode-fly [data-chat-connector]').length===2`);
      await click('[data-chat-connector="linear"] .mode-switch'); await settle();
      await check(theme + ' switching a connector off writes the chat only', `JSON.stringify(evidence.calls.at(-1))==='{"id":"fixture","patch":{"disabledConnectors":["linear"]}}'`);
      await capture(`${kind}-connectors-${theme}`);
      await click('[data-chat-connector="linear"] .mode-switch'); await settle();
      await click('[data-mode-fly="connectors"]'); await settle();
      await click('[data-effort="low"]'); await settle();
      await check(theme + ' effort writes the chat, not settings', `JSON.stringify(evidence.calls.at(-1))==='{"id":"fixture","patch":{"effort":"low"}}'`);
      await capture(`${kind}-effort-${theme}`);
      await click('[data-saved-mode="deep-work"]'); await settle();
      await check(theme + ' applying Deep work is one per-chat write', `JSON.stringify(evidence.calls.filter(c=>c.patch).at(-1).patch)==='{"executionMode":"worktree","gitIsolation":true,"mode":"yolo","offline":false,"incognito":false,"disabledTools":[],"workMode":"best-output","effort":"high"}'`);
      await check(theme + ' Deep work now active', `document.querySelector('.mode-head h2').innerText.startsWith('Deep work')`);
      await check(theme + ' button names the mode', `document.querySelector('.ctl-menu').innerText.includes('Deep work')`);
      await capture(`${kind}-applied-${theme}`);
      await run(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`); await settle();
      await check(theme + ' Escape closes the panel', `!document.querySelector('.mode-panel')`);
      await capture(`${kind}-button-${theme}`);
      await run(`evidence.set({workMode:'best-output',mode:'guardrails',effort:undefined})`);
    }
    if (kind === 'after') {
      win.setContentSize(600, 900); await settle();
      await run(`document.documentElement.dataset.theme='dark'`);
      await click('.ctl-menu'); await settle();
      await check('narrow panel inside viewport', inView('.mode-panel'));
      await check('narrow body does not scroll sideways', `document.documentElement.scrollWidth<=innerWidth`);
      await capture(`${kind}-narrow-dark`);
    }
    report.background = { focused: win.isFocused(), bounds: win.getBounds() };
  } catch (e) { report.errors.push(String(e)); }
  finally { fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(report, null, 2)); console.log(kind, JSON.stringify({ failed: report.checks.filter((c) => !c.passed), passed: report.checks.filter((c) => c.passed).length, errors: report.errors })); win.destroy(); app.exit(report.errors.length || report.checks.some((c) => !c.passed) ? 1 : 0); }
});
