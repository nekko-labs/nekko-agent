// Synthetic renderer only: hidden (never shown), non-focusable, network blocked.
// Evidence for the slimmer transcript: a turn's working-steps lines sit close to
// the notes and steps around them, while a prompt keeps the full 20px gap.
// Run: NEKKO_CONTROLS_SANDBOX=transcript-spacing-sandbox.cjs node agent-window-controls-integration.cjs
// (add NEKKO_TEST_REVISION=<rev> for the base-revision "before" capture; checks
// are recorded there but only enforced on the working tree).
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through agent-window-controls-integration.cjs');
const runDir = path.join(out, 'transcript-spacing-' + new Date().toISOString().replace(/[:.]/g, '-'));
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
  // Never shown: on macOS a shown window placed off-screen is moved back onto a display.
  const win = new BrowserWindow({ width: 1100, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, title: 'Transcript spacing synthetic sandbox', webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('Sandbox took OS focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const check = (name, ok, facts) => { report.checks.push({ name, ok, facts }); if (!ok && !base) throw Error('Check failed: ' + name + ' ' + JSON.stringify(facts)); };
  const until = async (expr, ms = 6000) => { for (let t = 0; t < ms; t += 100) { if (await run(expr)) return true; await sleep(100); } return false; };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    if (!await until('!!window.integration && !!document.querySelector(".command-wall-window")', 15000)) throw Error('Fixture did not mount');
    // A turn shaped like a real one: notes between runs of tool calls, then the reply and the next prompt.
    await run(`(() => {
      const s = JSON.parse(JSON.stringify(integration.records()[0]));
      let t = 10, n = 0;
      const say = (content, calls) => {
        const ids = calls.map(() => 'c' + (++n));
        s.messages.push({ id: 'a' + n, role: 'assistant', content, createdAt: t++, toolCalls: calls.map((input, i) => ({ id: ids[i], name: 'bash', input })) });
        ids.forEach((id, i) => s.messages.push({ id: 'r' + id, role: 'tool', content: '', createdAt: t++, toolResult: { toolCallId: id, output: 'ok', isError: false } }));
      };
      s.messages.push({ id: 'u-spacing', role: 'user', content: 'Ship the panel change', createdAt: t++ });
      say('Now the spec row, task entry and release notes.', [{ command: 'npm run build' }]);
      say('Build and version check pass. Now capturing before/after screenshots.', [{ command: 'ls' }, { command: 'git status' }, { command: 'git diff --stat' }]);
      say('Scratch daemon and dev UI are up; setting up a headless browser.', [{ command: 'grep -rn panel src' }, { command: 'cat src/panel.tsx' }]);
      say('Both shots are good. Committing and opening the PR.', [{ command: 'git commit -m panel' }, { command: 'git push' }]);
      s.messages.push({ id: 'a-reply', role: 'assistant', content: 'The rest of CI is still running. Waiting on it before merging.', createdAt: t++ });
      s.messages.push({ id: 'u-next', role: 'user', content: 'Thanks', createdAt: t++ });
      sessionStorage.setItem('fixture-record', JSON.stringify(s));
      integration.reset();
    })()`);
    await sleep(800);
    if (!await until('document.querySelectorAll("[data-activity-group], .vt-row .font-mono").length >= 4', 8000)) throw Error('Activity rows did not render');
    await sleep(600);
    // Gap = from the lowest laid-out content in a row (hidden hover rows included) to the next row, for each kind of neighbour.
    const gaps = await run(`(() => {
      const rows = [...document.querySelectorAll('.vt-row')];
      const kind = el => el.querySelector('.font-mono.text-xs > div > button[aria-expanded]') ? 'activity' : (el.textContent || '').match(/Ship the panel change|^\\s*Thanks/) ? 'prompt' : 'text';
      return rows.slice(0, -1).map((el, i) => ({ from: kind(el), to: kind(rows[i + 1]), gap: Math.round(rows[i + 1].getBoundingClientRect().top - Math.max(...[...el.querySelectorAll('*')].filter(c => getComputedStyle(c).position !== 'absolute' && c.getBoundingClientRect().height > 0 && c.textContent.trim()).map(c => c.getBoundingClientRect().bottom))) }));
    })()`);
    report.gaps = gaps;
    const f = path.join(runDir, 'transcript-1100.png');
    fs.writeFileSync(f, (await win.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
    report.captures.push(f);
    const inTurn = gaps.filter(g => (g.from === 'activity' || g.to === 'activity') && g.from !== 'prompt' && g.to !== 'prompt');
    check('working-steps lines sit close to the turn text around them', inTurn.length >= 6 && inTurn.every(g => g.gap <= 12), inTurn);
    check('a prompt keeps the full gap', gaps.filter(g => g.from === 'prompt' || g.to === 'prompt').every(g => g.gap >= 18), gaps);
    // Hovering a note shows its actions over its corner, with nothing pushed down.
    const note = await run(`(() => { const el = [...document.querySelectorAll('.msg-ai[data-voice="working"]')].find(e => /headless browser/.test(e.textContent)); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2) }; })()`);
    if (note) {
      win.webContents.sendInputEvent({ type: 'mouseMove', x: note.x, y: note.y }); await sleep(400);
      const hovered = await run(`(() => { const a = [...document.querySelectorAll('.msg-ai[data-voice="working"] [data-message-actions]')].find(e => /headless browser/.test(e.closest('.msg-ai').textContent)); return a ? { opacity: +getComputedStyle(a).opacity, position: getComputedStyle(a).position } : null; })()`);
      check('hovering a note shows its actions floating over it', !!hovered && hovered.opacity > 0.9 && hovered.position === 'absolute', hovered);
      const h = path.join(runDir, 'transcript-hover-note-1100.png');
      fs.writeFileSync(h, (await win.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
      report.captures.push(h);
    }
    if (win.isFocused() || win.isVisible()) throw Error('Background invariant failed: the window was shown or focused');
    report.success = report.errors.length === 0;
  } catch (e) { report.errors.push(String(e && e.stack || e)); report.success = false; }
  finally {
    fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ runDir, success: report.success, gaps: report.gaps, checks: report.checks.map(c => `${c.ok ? 'ok ' : 'NO '} ${c.name}`), errors: report.errors.slice(0, 5) }, null, 2));
    win.destroy(); app.exit(report.success ? 0 : 1);
  }
});
