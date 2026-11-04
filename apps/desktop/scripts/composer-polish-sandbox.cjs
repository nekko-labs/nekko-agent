// Synthetic renderer only: hidden (never shown), non-focusable, network blocked.
// Evidence for #1562 / #1565: the open-PR status lives on the transcript's PR
// card (no strip below the composer), the composer's bottom gap is 4px and its
// side gaps never drop below 4px, and a new chat in Dynamic (grid) layout
// starts with the centred greeting and composer, expanding on the first send.
// Run: NEKKO_CONTROLS_SANDBOX=composer-polish-sandbox.cjs node agent-window-controls-integration.cjs
// (add NEKKO_TEST_REVISION=<rev> for the base-revision "before" captures; checks
// are recorded there but only enforced on the working tree).
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through agent-window-controls-integration.cjs');
const runDir = path.join(out, 'composer-polish-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(runDir, { recursive: true });
app.setPath('userData', path.join(runDir, 'profile'));
app.setPath('sessionData', path.join(runDir, 'profile'));
const base = !!process.env.NEKKO_TEST_REVISION;
const report = { revision: process.env.NEKKO_TEST_REVISION || 'working-tree', checks: [], captures: [], errors: [] };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const jsLiteralCharMap = {
  '<': '\\u003C',
  '>': '\\u003E',
  '/': '\\u002F',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029'
};
const toSafeJsLiteral = value => JSON.stringify(value).replace(/[<>/\u2028\u2029]/g, ch => jsLiteralCharMap[ch]);
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  // Never shown: on macOS a shown window placed off-screen is moved back onto a display.
  const win = new BrowserWindow({ width: 1400, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, title: 'Composer polish synthetic sandbox', webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('Sandbox took OS focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const shot = async () => (await win.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG();
  const capture = async name => { const f = path.join(runDir, name + '.png'); fs.writeFileSync(f, await shot()); report.captures.push(f); };
  const check = (name, ok, facts) => { report.checks.push({ name, ok, facts }); if (!ok && !base) throw Error('Check failed: ' + name + ' ' + JSON.stringify(facts)); };
  const until = async (expr, ms = 6000) => { for (let t = 0; t < ms; t += 100) { if (await run(expr)) return true; await sleep(100); } return false; };
  const slow = async rate => { if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Animation.enable'); await win.webContents.debugger.sendCommand('Animation.setPlaybackRate', { playbackRate: rate }); };
  const frames = async (name, count, gap) => {
    const dir = path.join(runDir, name); fs.mkdirSync(dir);
    const buffers = [];
    for (let i = 0; i < count; i++) { const png = await shot(); buffers.push(png); fs.writeFileSync(path.join(dir, String(i).padStart(3, '0') + '.png'), png); await sleep(gap); }
    const gif = path.join(runDir, name + '.gif');
    try { require('./evidence-gif.cjs')(gif, buffers, 8); report.captures.push(gif); } catch (e) { report.gifLimitation = String(e).slice(0, 400); }
  };
  const wall = mode => run(`(() => { const w = integration.state().settings.commandWall; __setWall({ ...w, layout: { ...w.layout, mode: ${toSafeJsLiteral(mode)} } }); })()`);
  try {
    await win.loadFile(path.join(out, 'index.html'));
    if (!await until('!!window.integration && !!document.querySelector(".command-wall-window")', 15000)) throw Error('Fixture did not mount');

    // 1. A chat with two open PRs: status and actions on the transcript's card, no strip below the composer.
    await run(`(() => {
      const prs = [401, 402].map(number => ({ url: 'https://github.com/nekko-labs/nekko-agent/pull/' + number, owner: 'nekko-labs', repo: 'nekko-agent', number, title: number === 401 ? 'Keep pull request actions on the card' : 'A longer synthetic title to exercise wrapping and truncation', state: 'open', checks: number === 401 ? 'passing' : 'pending', isDraft: number === 402, reviewDecision: number === 401 ? 'APPROVED' : null }));
      window.nekko.listSessionPrs = async () => prs;
      const s = JSON.parse(JSON.stringify(integration.records()[0]));
      s.messages.push(...[401, 402].flatMap(n => [{ id: 'call-' + n, role: 'assistant', content: 'Opened a pull request.', createdAt: 3, toolCalls: [{ id: 'pr-' + n, name: 'bash', input: { command: 'gh pr create --title synthetic --body synthetic' } }] }, { id: 'result-' + n, role: 'tool', content: '', createdAt: 4, toolResult: { toolCallId: 'pr-' + n, output: 'https://github.com/nekko-labs/nekko-agent/pull/' + n, isError: false } }]));
      sessionStorage.setItem('fixture-record', JSON.stringify(s));
      integration.reset();
    })()`);
    await sleep(600); await wall('focus'); await sleep(1500);
    const pr = await run(`(() => {
      const transcript = document.querySelector('.command-wall-window[data-wall-hero]') || document;
      const section = transcript.querySelector('.composer-section');
      const strip = !!document.querySelector('[aria-label="Pending pull requests"], .pr-action-deck');
      const below = section && [...document.querySelectorAll('.pr-action-deck, [aria-label="Pending pull requests"]')].some(el => el.getBoundingClientRect().top >= section.getBoundingClientRect().top - 2);
      const labels = [...transcript.querySelectorAll('button')].filter(b => !b.closest('.composer-section, .pr-action-deck, [aria-label="Pending pull requests"]')).map(b => (b.textContent || '').trim()).filter(t => /^(Approve|Decline|Merge|Review)$/.test(t));
      const card = [...transcript.querySelectorAll('[data-pr-card], .pr-card, [aria-label*="pull request" i]')].length;
      return { strip, below: !!below, actions: labels, cardNodes: card };
    })()`);
    check('no PR strip below the composer', !pr.strip && !pr.below, pr);
    check('PR actions are on the transcript card', pr.actions.length > 0, pr);
    await capture('1-open-pr-focus-1400');

    // 2. Composer gaps: 4px below it, and at least 4px each side however narrow the window.
    await run("sessionStorage.removeItem('fixture-record'); integration.reset()"); await sleep(600);
    await wall('focus'); await sleep(800);
    const gaps = [];
    for (const width of [1400, 700, 420, 340]) {
      win.setContentSize(width, 900); await sleep(700);
      const g = await run(`(() => {
        const section = document.querySelector('.command-wall-window[data-wall-hero] .composer-section') || document.querySelector('.composer-section');
        const column = section && section.querySelector('.composer-column');
        if (!section || !column) return null;
        const s = section.getBoundingClientRect(), c = column.getBoundingClientRect(), cs = getComputedStyle(section);
        const left = c.left - (s.left + parseFloat(cs.paddingLeft)), right = (s.right - parseFloat(cs.paddingRight)) - c.right;
        return { paddingBottom: parseFloat(cs.paddingBottom), left: +left.toFixed(2), right: +right.toFixed(2), section: +s.width.toFixed(1) };
      })()`);
      gaps.push({ width, ...g });
      if (width === 340) await capture('2-compressed-340');
    }
    win.setContentSize(1400, 900); await sleep(500);
    check('4px below the composer', gaps.every(g => g.paddingBottom === 4), gaps);
    check('at least 4px each side of the composer at every width', gaps.every(g => g.left >= 3.99 && g.right >= 3.99), gaps);

    // 3. Dynamic (grid): a new agent starts with the centred greeting and composer, and expands on the first send.
    await wall('grid'); await sleep(800);
    await run(`(() => { let n = 0; window.nekko.createSession = async (workspaceId) => { const s = { id: 'fresh-' + (++n), title: 'New chat', createdAt: Date.now(), updatedAt: Date.now(), providerId: 'fixture', modelId: 'fixture-model', mode: 'guardrails', chatType: 'multimodal', workspaceId, messages: [], attachments: [], queuedPrompts: [] }; integration.records().push(s); return s; }; })()`);
    await run(`document.querySelector('[aria-label="New agent"]').click()`);
    // The greeting must be on screen in a grid window, not merely in the DOM, and settled.
    const seen = `(() => { const g = [...document.querySelectorAll('.command-wall-window [data-clean-start-greeting]')].find(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth && getComputedStyle(el).visibility !== 'hidden' && +getComputedStyle(el).opacity > 0.9; }); if (!g) return null; const w = g.closest('.command-wall-window'); const r = g.getBoundingClientRect(); return { cell: w?.dataset.gridCell, top: Math.round(r.top), left: Math.round(r.left) }; })()`;
    let greeted = null, last = '';
    for (let t = 0; t < 8000; t += 200) { const g = await run(seen); const k = JSON.stringify(g); if (g && k === last) { greeted = g; break; } last = k; await sleep(200); }
    const grid = await run(`({ mode: document.querySelector('[data-wall-layout]')?.dataset.wallLayout, windows: document.querySelectorAll('.command-wall-window').length })`);
    check('grid: a new agent shows the centred greeting on screen', grid.mode !== 'focus' && !!greeted && /fresh-/.test(greeted.cell || ''), { ...grid, greeted });
    await sleep(300); await capture('3-grid-new-agent-1400');
    if (greeted) {
      await run(`(() => { const ed = document.querySelector('[data-clean-start] .composer [contenteditable], [data-clean-start] .composer textarea'); ed.focus(); if (ed.tagName === 'TEXTAREA') { const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(ed, 'Tidy up the release notes'); ed.dispatchEvent(new Event('input', { bubbles: true })); } else { document.execCommand('insertText', false, 'Tidy up the release notes'); } })()`);
      await sleep(300);
      await slow(0.1);
      await run(`(() => { const ed = document.querySelector('[data-clean-start] .composer [contenteditable], [data-clean-start] .composer textarea'); ed.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
      await frames('4-grid-first-send-motion', 30, 40);
      await slow(1); await sleep(900);
      const sent = await run(`({ clean: !!document.querySelector('[data-clean-start-greeting]'), sent: integration.calls.some(c => c.method === 'send') })`);
      check('grid: the first send expands into the full chat', !sent.clean && sent.sent, sent);
      await capture('5-grid-after-send-1400');
    }
    if (win.isFocused() || win.isVisible()) throw Error('Background invariant failed: the window was shown or focused');
    report.success = report.errors.length === 0;
  } catch (e) { report.errors.push(String(e && e.stack || e)); report.success = false; }
  finally {
    fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ runDir, success: report.success, checks: report.checks.map(c => `${c.ok ? 'ok ' : 'NO '} ${c.name}`), errors: report.errors.slice(0, 5) }, null, 2));
    win.destroy(); app.exit(report.success ? 0 : 1);
  }
});
