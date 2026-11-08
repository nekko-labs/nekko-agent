// Synthetic-only attribution journey. No real bridge, network, or visible windows.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
app.setPath('userData', path.join(out, 'profile'));
app.disableHardwareAcceleration();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { checks: [], errors: [], captures: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1440, height: 900, show: false, focusable: false, skipTaskbar: true, x: -10000, y: -10000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const run = code => win.webContents.executeJavaScript(code, true);
  const shot = async name => { const file = path.join(out, name + '.png'); fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG()); report.captures.push(file); };
  const check = async (name, code) => { const value = await run(code); report.checks.push({ name, value }); if (!value && !process.env.NEKKO_TEST_SOURCE) throw Error(name); };
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 100 && !await run('!!window.layoutFixture'); i++) await sleep(100);
    await run(`(() => {
      const f = layoutFixture, parent = f.records[0];
      parent.title = 'Source: investigate local delegation';
      const call = { id: 'route-call', name: 'spawn_agent', input: { title: 'Local Qwen review', task: 'Review renderer attribution', provider_id: 'ollama-local', model_id: 'qwen3:8b' } };
      parent.messages = [{ id: 'request', role: 'user', content: 'Delegate a focused review.', createdAt: 1 }, { id: 'delegate-call', role: 'assistant', content: 'Delegating the review.', toolCalls: [call], createdAt: 2 }];
      const child = { ...parent, id: 'local-child', title: 'Local Qwen review', parentSessionId: parent.id, providerId: 'ollama-local', modelId: 'qwen3:8b', messages: [{ id: 'reply', role: 'assistant', content: 'Review completed.', createdAt: 3 }] };
      const nested = { ...child, id: 'nested-child', title: 'Nested verification', parentSessionId: child.id };
      f.records.push(child, nested);
      for (const s of [parent, child, nested]) f.putCachedSession(s);
      f.store.setState({ providers: [...f.store.getState().providers, { id: 'ollama-local', label: 'Ollama (local)', kind: 'ollama', enabled: true }], planRailOpen: true, focusRequest: { sessionId: parent.id } });
      f.store.getState().refreshSessions();
    })()`);
    await sleep(1400);
    await shot('parent-wide');
    win.setContentSize(480, 900); await sleep(500); await shot('parent-narrow');
    win.setContentSize(1440, 900); await sleep(500);
    await check('parent displays local child model', `document.body.innerText.includes('qwen3:8b')`);
    await run(`layoutFixture.store.getState().focusChatOnWall('local-child')`);
    await sleep(900);
    await shot('child-wide');
    await check('child names source and model', `[...document.querySelectorAll('[data-subagent-banner]')].some(e => e.textContent.includes('Source: investigate') && e.textContent.includes('qwen3:8b'))`);
    win.setContentSize(480, 900); await sleep(500); await shot('child-narrow');
    win.setContentSize(1440, 900);
    await run(`layoutFixture.store.getState().focusChatOnWall('nested-child')`); await sleep(800);
    await shot('nested-wide');
    await check('nested child names immediate parent', `[...document.querySelectorAll('[data-subagent-banner]')].some(e => e.textContent.includes('Local Qwen review'))`);
    await run(`[...document.querySelectorAll('[data-subagent-banner] button')].find(e => e.textContent.includes('Local Qwen review')).click()`);
    await sleep(600);
    await check('parent navigation opens the immediate parent', `[...document.querySelectorAll('[data-subagent-banner]')].some(e => e.textContent.includes('Source: investigate local delegation'))`);
    report.hidden = !win.isVisible(); report.focused = win.isFocused(); report.bounds = win.getBounds();
    if (!report.hidden || report.focused) throw Error('Isolation invariant failed');
    report.success = true;
  } catch (e) { report.errors.push(String(e.stack || e)); report.success = false; }
  finally { fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); win.destroy(); app.exit(report.success ? 0 : 1); }
});
