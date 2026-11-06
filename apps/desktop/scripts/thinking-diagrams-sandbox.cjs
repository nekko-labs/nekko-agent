// Matching before/after evidence for composer reasoning and Mermaid canvases.
// Runs the real renderer with a stub bridge, hidden and non-focusable. No network or host data.
// NEKKO_LAYOUT_SANDBOX=thinking-diagrams-sandbox.cjs node apps/desktop/scripts/layout-evidence-integration.cjs
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Use layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'chat-artifacts-profile'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { source: process.env.NEKKO_TEST_SOURCE || 'worktree', captures: [], metrics: {}, errors: [] };

const js = v => JSON.stringify(v).replace(/[<>/\u2028\u2029]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const reply = 'Here is the workflow:\n\n```mermaid\nflowchart LR\n A[Plan] --> B[Implement] --> C[Verify] --> D[Ship]\n```\n\nThe diagram stays inside the conversation.';

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:|about:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const displays = screen.getAllDisplays();
  const win = new BrowserWindow({ width: 1440, height: 1100, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: Math.min(...displays.map(d => d.bounds.x)) - 1700, y: Math.min(...displays.map(d => d.bounds.y)) - 1200, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const run = code => win.webContents.executeJavaScript(code, true);
  win.on('focus', () => report.errors.push('Window received focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  const capture = async name => {
    if (win.isVisible() || win.isFocused()) report.errors.push(`${name}: window visible or focused`);
    // A hidden window can hand back its last frame; ask for a fresh one first.
    win.webContents.invalidate();
    await wait(400);
    const file = path.join(out, `${name}.png`);
    fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG());
    report.captures.push(file);
  };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 80 && !await run('!!window.layoutFixture && !!document.querySelector("[data-command-wall]")'); i++) await wait(100);
    await wait(500);
    await run(`(() => {
      const f = window.layoutFixture;
      const s = f.records[0];
      s.modelId = 'gpt-5';
      f.store.setState({ models: [{ id: 'gpt-5', providerId: 'fixture', name: 'GPT-5', contextWindow: 128000 }] });
      f.bridge.listModels = async () => [{ id: 'gpt-5', providerId: 'fixture', name: 'GPT-5', contextWindow: 128000 }];
      s.messages = [
        { id: 'u1', role: 'user', content: 'Show the delivery workflow.', createdAt: Date.now() - 60000 },
        { id: 'a1', role: 'assistant', content: ${js(reply)}, createdAt: Date.now() - 30000 },
      ];
      f.putCachedSession(s);
      f.store.getState().openChatPane(s.id);
      // Keep the same seeded wall layout in baseline and head captures.
      const st = f.store.getState();
      f.store.setState({ settings: { ...st.settings, commandWall: { ...(st.settings.commandWall || {}), dock: { ...((st.settings.commandWall || {}).dock || {}), show: false } } } });
    })()`);
    await wait(500);
    // The Focused wall shows one agent: pick this chat from its list (a DOM click, not OS input).
    report.metrics.picked = await run(`(() => {
      const hit = [...document.querySelectorAll('button,[role="button"],a,[tabindex]')].find(e => e.textContent.includes('Persist quota history') || e.textContent.includes('Persist qu'));
      if (hit) hit.click();
      return hit ? hit.tagName + ' ' + hit.className.slice(0, 80) : null;
    })()`);
    for (let i = 0; i < 50 && !await run('!!document.querySelector(\'[data-mermaid-diagram]\')'); i++) await wait(100);
    await wait(3000);
    await run(`window.dispatchEvent(new CustomEvent('nekko-session-brain', { detail: { id: 'a', session: { ...window.layoutFixture.records[0], providerId: 'fixture', modelId: 'gpt-5' } } }))`);
    await wait(500);
    // Animations and transitions stay paused in a hidden window (the wall's entry, the theme switch); settle them.
    await win.webContents.insertCSS('*,*::before,*::after{animation:none!important;transition:none!important}');
    await wait(300);
    report.metrics.fade = await run(`(() => { const out = []; for (let e = document.querySelector('[data-mermaid-diagram]'); e; e = e.parentElement) { const c = getComputedStyle(e); if (c.opacity !== '1' || c.transform !== 'none' || c.filter !== 'none' || c.animationName !== 'none') out.push({ tag: e.tagName, cls: String(e.className).slice(0, 90), opacity: c.opacity, transform: c.transform, filter: c.filter, anim: c.animationName, state: c.animationPlayState }); } return out; })()`);
    // The first frame after the settle can still be the paused animation's; discard one.
    await win.capturePage(undefined, { stayHidden: true });
    await wait(600);
    for (const theme of ['dark']) {
      await run(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
      await wait(600);
      for (const width of [1440, 600]) {
        win.setContentSize(width, 1100); await wait(600);
        report.metrics[width] = await run(`(() => { const d = document.querySelector('[data-mermaid-diagram]'); return { bounds: d?.getBoundingClientRect().toJSON(), border: d && getComputedStyle(d).borderWidth, background: d && getComputedStyle(d).backgroundColor, thinkingControl: !!document.querySelector('[title^="Reasoning is"]'), sandbox: d?.querySelector('iframe')?.getAttribute('sandbox') }; })()`);
        await capture(`diagram-composer-${width}`);
      }
      win.setContentSize(1440, 1100);
      await run(`document.querySelector('[data-mermaid-expand]')?.click()`); await wait(600);
      report.metrics.expanded = await run(`!!document.querySelector('[data-mermaid-fullscreen] [data-zoom-frame] iframe')`);
      await capture('diagram-expanded');
      await run(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'}))`);
      report.metrics.closed = await run(`!document.querySelector('[data-mermaid-fullscreen]')`);
    }
  } catch (e) { report.errors.push(String(e && e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  win.destroy(); app.exit(report.captures.length === 3 && report.metrics.expanded && report.metrics.closed ? 0 : 1);
});
