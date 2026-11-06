// Synthetic renderer only: hidden, off-screen, non-focusable, network blocked.
// Run: NEKKO_CONTROLS_SANDBOX=focus-strip-sandbox.cjs node agent-window-controls-integration.cjs
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through agent-window-controls-integration.cjs');
const runDir = path.join(out, 'focus-strip-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(runDir, { recursive: true });
app.setPath('userData', path.join(runDir, 'profile'));
app.setPath('sessionData', path.join(runDir, 'profile'));
const report = { checks: [], captures: [], errors: [] };
const js = (v) => JSON.stringify(v).replace(/[<>/\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const displays = screen.getAllDisplays().map(d => d.bounds);
  const win = new BrowserWindow({ width: 1400, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: Math.min(...displays.map(d => d.x)) - 3000, y: Math.min(...displays.map(d => d.y)) - 2000, title: 'Focus strip synthetic sandbox', webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('Sandbox took OS focus'));
  const run = s => win.webContents.executeJavaScript(s, true);
  // A hidden window hands back its last painted frame, so ask once to force a paint and keep the next.
  const capture = async (name, rect) => { await win.capturePage(undefined, { stayHidden: true, stayAwake: true }); await sleep(400); const f = path.join(runDir, name + '.png'); fs.writeFileSync(f, (await win.capturePage(rect, { stayHidden: true, stayAwake: true })).toPNG()); report.captures.push(f); };
  const check = (name, ok, facts) => { report.checks.push({ name, ok, facts }); };
  const until = async (expr, ms = 6000) => { for (let t = 0; t < ms; t += 100) { if (await run(expr)) return true; await sleep(100); } return false; };
  const focusWall = theme => run(`(() => {
    document.documentElement.dataset.theme=${js(theme)};
    const w = integration.state().settings.commandWall;
    __setWall({ ...w, layout: { ...w.layout, mode: 'focus' }, hero: 'existing', dock: { ...w.dock, show: true, side: 'right' } });
  })()`);
  const stripFacts = `(() => {
    const strip = document.querySelector('.command-wall-window[data-wall-hero] [data-pane-title-strip]');
    if (!strip) return null;
    const css = getComputedStyle(strip), r = strip.getBoundingClientRect(), panel = strip.parentElement.getBoundingClientRect();
    const labels = [...strip.querySelectorAll('button')].map(b => b.getAttribute('aria-label') || b.textContent.trim());
    return { display: css.display, x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height), panelTop: Math.round(panel.top), draggable: strip.draggable, title: strip.getAttribute('title'), cursor: css.cursor, text: strip.textContent.trim().slice(0, 80), labels, zen: !!strip.querySelector('.agent-zen-action'), number: !!strip.querySelector('.wall-number') };
  })()`;
  try {
    await win.loadFile(path.join(out, 'index.html'));
    if (!await until('!!window.integration && !!document.querySelector(".command-wall-window")')) throw Error('Fixture did not mount');
    for (const theme of ['dark', 'light']) {
      await run('integration.reset()'); await sleep(400);
      await focusWall(theme); await sleep(600);
      await run(`document.querySelector('[aria-label="Detailed: every control"]')?.click()`); await sleep(500);
      const s = await run(stripFacts);
      report[theme] = s;
      check(theme + ': hero shows its title strip', !!s && s.display !== 'none' && s.height > 0 && s.y === s.panelTop, s);
      check(theme + ': strip carries name and controls, no window number', !!s && !s.number && s.labels.some(l => /^Minimize/.test(l)) && s.labels.some(l => /^(Complete|Close|Delete)/.test(l)) && s.labels.includes('Open agent logs'), s);
      check(theme + ': strip cannot be dragged and does not offer to', !!s && !s.draggable && s.title === null && s.cursor !== 'grab', s);
      check(theme + ': no Zen button on the window already focused', !!s && !s.zen, s);
      await capture(`focused-${theme}-1400`);
      if (s?.height) await capture(`strip-${theme}`, { x: s.x, y: Math.max(0, s.y - 8), width: s.width, height: s.height + 24 });
    }
    await run(`(() => { const w = integration.state().settings.commandWall; __setWall({ ...w, dock: { ...w.dock, show: false } }); })()`);
    win.setContentSize(760, 900); await sleep(700);
    const narrow = await run(`(() => { const s = ${stripFacts}; const strip = document.querySelector('.command-wall-window[data-wall-hero] [data-pane-title-strip]'); return { ...s, overflows: strip.scrollWidth > strip.clientWidth + 1 }; })()`);
    check('760px: strip fits', !narrow.overflows, narrow);
    await capture('focused-light-760');
    win.setContentSize(1400, 900); await sleep(500);
    // A new chat stays one centred composer on a quiet page, until the first send.
    await run(`(() => { let n = 0; window.nekko.createSession = async (workspaceId) => { const s = { id: 'fresh-' + (++n), title: 'New chat', createdAt: Date.now(), updatedAt: Date.now(), providerId: 'fixture', modelId: 'fixture-model', mode: 'guardrails', chatType: 'multimodal', workspaceId, messages: [], attachments: [], queuedPrompts: [] }; integration.records().push(s); return s; }; })()`);
    await run(`document.querySelector('[aria-label="New agent"]').click()`);
    await until('!!document.querySelector("[data-clean-start-greeting]")'); await sleep(900);
    const clean = await run(stripFacts);
    check('clean start keeps the strip hidden', !!clean && clean.display === 'none', clean);
    await capture('clean-start-light-1400');
    await run(`(() => { const ed = document.querySelector('[data-clean-start] .composer [contenteditable], [data-clean-start] .composer textarea'); ed.focus(); if (ed.tagName === 'TEXTAREA') { const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(ed, 'Tidy up the release notes'); ed.dispatchEvent(new Event('input', { bubbles: true })); } else { document.execCommand('insertText', false, 'Tidy up the release notes'); } })()`);
    await sleep(300);
    await run(`document.querySelector('[data-clean-start] .composer [contenteditable], [data-clean-start] .composer textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`);
    await sleep(1500);
    const sent = await run(stripFacts);
    check('first send brings the strip in', !!sent && sent.display !== 'none' && sent.height > 0, sent);
    await capture('after-send-light-1400');
    if (win.isFocused() || displays.some(d => { const b = win.getBounds(); return b.x < d.x + d.width && b.x + b.width > d.x && b.y < d.y + d.height && b.y + b.height > d.y; })) throw Error('Background invariant failed');
    report.success = report.errors.length === 0 && report.checks.every(c => c.ok);
  } catch (e) { report.errors.push(String(e && e.stack || e)); report.success = false; }
  finally {
    fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ runDir, success: report.success, checks: report.checks.map(c => `${c.ok ? 'ok ' : 'NO '} ${c.name}${c.ok ? '' : ' ' + JSON.stringify(c.facts)}`), dark: report.dark, errors: report.errors.slice(0, 5) }, null, 2));
    win.destroy(); app.exit(report.success ? 0 : 1);
  }
});
