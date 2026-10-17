// Synthetic renderer only: hidden, off-screen, non-focusable, network blocked.
// Run: NEKKO_CONTROLS_SANDBOX=focus-transitions-sandbox.cjs node agent-window-controls-integration.cjs
// (add NEKKO_TEST_REVISION=<rev> for the base-revision "before" captures).
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through agent-window-controls-integration.cjs');
const runDir = path.join(out, 'focus-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(runDir, { recursive: true });
app.setPath('userData', path.join(runDir, 'profile'));
app.setPath('sessionData', path.join(runDir, 'profile'));
const base = !!process.env.NEKKO_TEST_REVISION;
const report = { revision: process.env.NEKKO_TEST_REVISION || 'working-tree', checks: [], captures: [], errors: [] };
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const displays = screen.getAllDisplays().map(d => d.bounds);
  const win = new BrowserWindow({ width: 1400, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: Math.min(...displays.map(d => d.x)) - 3000, y: Math.min(...displays.map(d => d.y)) - 2000, title: 'Focus transitions synthetic sandbox', webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.showInactive();
  win.on('focus', () => report.errors.push('Sandbox took OS focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const shot = async () => (await win.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG();
  const capture = async name => { const f = path.join(runDir, name + '.png'); fs.writeFileSync(f, await shot()); report.captures.push(f); };
  const check = (name, ok, facts) => { report.checks.push({ name, ok, facts }); if (!ok && !base) throw Error('Check failed: ' + name + ' ' + JSON.stringify(facts)); };
  const until = async (expr, ms = 6000) => { for (let t = 0; t < ms; t += 100) { if (await run(expr)) return true; await sleep(100); } return false; };
  // Animations at a tenth of their speed, so sampled frames show the motion.
  const slow = async rate => { if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Animation.enable'); await win.webContents.debugger.sendCommand('Animation.setPlaybackRate', { playbackRate: rate }); };
  const frames = async (name, count, gap) => {
    const dir = path.join(runDir, name); fs.mkdirSync(dir);
    for (let i = 0; i < count; i++) { fs.writeFileSync(path.join(dir, String(i).padStart(3, '0') + '.png'), await shot()); await sleep(gap); }
    const mp4 = path.join(runDir, name + '.mp4');
    const r = cp.spawnSync('ffmpeg', ['-y', '-framerate', '10', '-i', path.join(dir, '%03d.png'), '-vf', 'scale=1120:-2,pad=ceil(iw/2)*2:ceil(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', mp4], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw Error(r.stderr); report.captures.push(mp4);
  };
  const focusWall = theme => run(`(() => {
    document.documentElement.dataset.theme=${JSON.stringify(theme)};
    const w = integration.state().settings.commandWall;
    __setWall({ ...w, layout: { ...w.layout, mode: 'focus' }, hero: 'existing', dock: { ...w.dock, show: true, side: 'right' } });
  })()`);
  // New chats start empty, as a real new agent does, so the clean-start prompt shows.
  const blankNewChats = () => run(`(() => { let n = 0; window.nekko.createSession = async (workspaceId) => { const s = { id: 'fresh-' + (++n), title: 'New chat', createdAt: Date.now(), updatedAt: Date.now(), providerId: 'fixture', modelId: 'fixture-model', mode: 'guardrails', chatType: 'multimodal', workspaceId, messages: [], attachments: [], queuedPrompts: [] }; integration.records().push(s); return s; }; })()`);
  try {
    await win.loadFile(path.join(out, 'index.html'));
    if (!await until('!!window.integration && !!document.querySelector(".command-wall-window")')) throw Error('Fixture did not mount');
    for (const theme of ['dark', 'light']) {
      await run('integration.reset()'); await sleep(400);
      await focusWall(theme); await sleep(900);
      const facts = await run(`(() => {
        const panel = document.querySelector('.command-wall-window[data-wall-selected] > .panel') || document.querySelector('.command-wall-window[data-wall-hero] > .panel');
        const seg = [...document.querySelectorAll('[aria-label="Wall layout"] button')].map(b => b.textContent.trim());
        return { mode: document.querySelector('[data-wall-layout]')?.dataset.wallLayout, ring: panel && getComputedStyle(panel).getPropertyValue('--panel-ring-color').trim(), segments: seg,
          bolt: !!document.querySelector('[aria-label="Wall layout"] button:nth-child(2) svg path[d^="M13 2"]'), dock: document.querySelector('.monitors-dock__toolbar strong')?.textContent };
      })()`);
      check(theme + ': focused layout', facts.mode === 'focus', facts);
      check(theme + ': toolbar shows Focused and Dynamic only', JSON.stringify(facts.segments) === '["Focused","Dynamic"]', facts);
      check(theme + ': Dynamic uses the bolt icon', facts.bolt, facts);
      check(theme + ': dock header reads Monitors', facts.dock === 'Monitors', facts);
      check(theme + ': calmer focus ring is a mix, not raw accent', /color-mix/.test(facts.ring || ''), facts);
      await capture(`focus-${theme}-1400`);
      // New agent in Focused: it becomes the hero, still Focused, and fades in.
      await blankNewChats();
      if (theme === 'dark') await slow(0.1);
      await run(`document.querySelector('[aria-label="New agent"]').click()`);
      if (theme === 'dark') await frames('new-agent-motion', 26, 40); else await sleep(700);
      if (theme === 'dark') await slow(1);
      await until('!!document.querySelector("[data-clean-start-greeting]")');
      const after = await run(`({ mode: document.querySelector('[data-wall-layout]')?.dataset.wallLayout, hero: document.querySelector('.command-wall-window[data-wall-hero]')?.dataset.gridCell, clean: !!document.querySelector('[data-clean-start-greeting]') })`);
      check(theme + ': New agent stays Focused on the new chat prompt', after.mode === 'focus' && /fresh-/.test(after.hero || '') && after.clean, after);
      await sleep(600); await capture(`new-agent-${theme}-1400`);
      // Type into the centred composer: it stays the prompt view while typing.
      await run(`(() => { const ed = document.querySelector('[data-clean-start] .composer [contenteditable], [data-clean-start] .composer textarea'); ed.focus(); if (ed.tagName === 'TEXTAREA') { const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(ed, 'Tidy up the release notes'); ed.dispatchEvent(new Event('input', { bubbles: true })); } else { document.execCommand('insertText', false, 'Tidy up the release notes'); } })()`);
      await sleep(400);
      check(theme + ': typing keeps the prompt view', await run('!!document.querySelector("[data-clean-start-greeting]")'), {});
      await capture(`typed-${theme}-1400`);
      // Send: the composer expands into the full chat.
      if (theme === 'dark') await slow(0.1);
      await run(`(() => { const ed = document.querySelector('[data-clean-start] .composer [contenteditable], [data-clean-start] .composer textarea'); ed.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
      if (theme === 'dark') await frames('composer-expand-motion', 30, 40); else await sleep(900);
      if (theme === 'dark') await slow(1);
      const sent = await run(`({ clean: !!document.querySelector('[data-clean-start-greeting]'), sent: integration.calls.some(c => c.method === 'send') })`);
      check(theme + ': first send opens the full chat', !sent.clean && sent.sent, sent);
      await sleep(900); await capture(`sent-${theme}-1400`);
    }
    if (win.isFocused() || displays.some(d => { const b = win.getBounds(); return b.x < d.x + d.width && b.x + b.width > d.x && b.y < d.y + d.height && b.y + b.height > d.y; })) throw Error('Background invariant failed');
    report.success = report.errors.length === 0;
  } catch (e) { report.errors.push(String(e && e.stack || e)); report.success = false; }
  finally {
    fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ runDir, success: report.success, checks: report.checks.map(c => `${c.ok ? 'ok ' : 'NO '} ${c.name}`), errors: report.errors.slice(0, 5) }, null, 2));
    win.destroy(); app.exit(report.success ? 0 : 1);
  }
});
