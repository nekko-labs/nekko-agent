// Synthetic renderer only: hidden, off-screen, non-focusable, network blocked.
// Run: NEKKO_CONTROLS_SANDBOX=empty-wall-sandbox.cjs node agent-window-controls-integration.cjs
// (add NEKKO_TEST_REVISION=<rev> for the base-revision "before" captures; checks
// are recorded but not enforced there).
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through agent-window-controls-integration.cjs');
const runDir = path.join(out, 'empty-wall-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(runDir, { recursive: true });
app.setPath('userData', path.join(runDir, 'profile'));
app.setPath('sessionData', path.join(runDir, 'profile'));
// NEKKO_BEFORE=1 records an unchanged checkout the same way (the base-archive
// build cannot resolve files outside the renderer).
const base = !!process.env.NEKKO_TEST_REVISION || process.env.NEKKO_BEFORE === '1';
const report = { revision: process.env.NEKKO_TEST_REVISION || 'working-tree', checks: [], captures: [], errors: [] };
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const displays = screen.getAllDisplays().map(d => d.bounds);
  const win = new BrowserWindow({ width: 1400, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: Math.min(...displays.map(d => d.x)) - 3000, y: Math.min(...displays.map(d => d.y)) - 2000, title: 'Empty wall synthetic sandbox', webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.showInactive();
  win.on('focus', () => report.errors.push('Sandbox took OS focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const shot = async () => (await win.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG();
  const capture = async name => { const f = path.join(runDir, name + '.png'); fs.writeFileSync(f, await shot()); report.captures.push(f); };
  const check = (name, ok, facts) => { report.checks.push({ name, ok, facts }); if (!ok && !base) throw Error('Check failed: ' + name + ' ' + JSON.stringify(facts)); };
  const until = async (expr, ms = 6000) => { for (let t = 0; t < ms; t += 100) { if (await run(expr)) return true; await sleep(100); } return false; };
  // New chats start empty, as a real new agent does.
  const blankNewChats = () => run(`(() => { let n = 0; window.nekko.createSession = async (workspaceId) => { integration.calls.push({ method: 'create' }); const s = { id: 'fresh-' + (++n), title: 'New chat', createdAt: Date.now(), updatedAt: Date.now(), providerId: 'fixture', modelId: 'fixture-model', mode: 'guardrails', chatType: 'multimodal', workspaceId, messages: [], attachments: [], queuedPrompts: [] }; integration.records().push(s); return s; }; })()`);
  const setWall = patch => run(`(() => { const w = integration.state().settings.commandWall; __setWall({ ...w, ...${patch} }); })()`);
  const creates = () => run(`integration.calls.filter(c => c.method === 'create').length`);
  try {
    await win.loadFile(path.join(out, 'index.html'));
    if (!await until('!!window.integration && !!document.querySelector(".command-wall-window")')) throw Error('Fixture did not mount');
    for (const theme of ['dark', 'light']) {
      await run('integration.reset()'); await sleep(400);
      await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      await blankNewChats();
      // 1. The wall is emptied (Dynamic layout, no windows at all).
      await setWall(`{ root: null, hero: null, layout: { ...w.layout, mode: 'grid' }, dock: { ...w.dock, show: false } }`);
      await sleep(1500);
      const empty = await run(`({ mode: document.querySelector('[data-wall-layout]')?.dataset.wallLayout, emptyState: !!document.querySelector('[data-wall-empty]'), clean: !!document.querySelector('[data-clean-start-greeting]'), hero: document.querySelector('.command-wall-window[data-wall-hero]')?.dataset.gridCell })`);
      empty.creates = await creates();
      check(theme + ': an empty wall opens the Focused new-chat screen', empty.mode === 'focus' && empty.clean && !empty.emptyState && /fresh-/.test(empty.hero || ''), empty);
      check(theme + ': exactly one chat was created', empty.creates === 1, empty);
      await capture(`empty-wall-${theme}-1400`);
      if (base && !empty.clean) {
        // The base revision has no transition: reach its clean start the old way.
        await setWall(`{ layout: { ...w.layout, mode: 'focus' } }`); await sleep(400);
        await run(`document.querySelector('[aria-label="New agent"]').click()`);
        await until('!!document.querySelector("[data-clean-start-greeting]")'); await sleep(900);
        await capture(`clean-start-${theme}-1400`);
      }
      // 2. Emptying it again reuses that untouched chat instead of making another.
      if (!base) await setWall(`{ root: null, hero: null, layout: { ...w.layout, mode: 'grid' } }`);
      await sleep(1500);
      const again = await run(`({ clean: !!document.querySelector('[data-clean-start-greeting]'), hero: document.querySelector('.command-wall-window[data-wall-hero]')?.dataset.gridCell })`);
      again.creates = await creates();
      check(theme + ': emptying again reuses the empty chat', again.clean && again.creates === 1 && again.hero === empty.hero, again);
      // 3. The glass composer: no halo behind it, a translucent blurred surface, a prism edge.
      const glass = await run(`(() => {
        const sec = document.querySelector('[data-clean-start] .clean-start');
        const c = document.querySelector('[data-clean-start] .composer');
        if (!sec || !c) return null;
        const cs = getComputedStyle(c), after = getComputedStyle(c, '::after'), aura = getComputedStyle(c.parentElement, '::before');
        return { sectionBg: getComputedStyle(sec).backgroundImage, composerBg: cs.backgroundColor, backdrop: cs.backdropFilter, edge: after.backgroundImage.slice(0, 40), aura: aura.backgroundImage.slice(0, 40) };
      })()`);
      check(theme + ': no radial halo behind the section', !!glass && !/radial-gradient/.test(glass.sectionBg), glass);
      check(theme + ': composer is translucent glass', !!glass && /blur/.test(glass.backdrop || '') && !/rgb\\(\\d+, \\d+, \\d+\\)$/.test(glass.composerBg), glass);
      check(theme + ': composer has a prism edge', !!glass && /gradient/.test(glass.edge), glass);
      // 4. Focused: type, so the focused prism edge shows.
      await run(`(() => { const ed = document.querySelector('[data-clean-start] .composer [contenteditable], [data-clean-start] .composer textarea'); ed.focus(); if (ed.tagName === 'TEXTAREA') { const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(ed, 'Tidy up the release notes'); ed.dispatchEvent(new Event('input', { bubbles: true })); } else { document.execCommand('insertText', false, 'Tidy up the release notes'); } })()`);
      await sleep(500);
      await capture(`clean-start-typed-${theme}-1400`);
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
