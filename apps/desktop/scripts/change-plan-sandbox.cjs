// Electron side of change-plan-integration.cjs. A hidden, unfocusable window on
// a throwaway profile with every network request cancelled. Gives the wall's
// synthetic agent a published plan, opens its Agent Monitor, clicks
// "Change plan", types a change and sends it (DOM events only, no OS input),
// recording what appears and which bridge call carries the change.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through change-plan-integration.cjs');
const runDir = path.join(out, new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(runDir, { recursive: true });
app.setPath('userData', path.join(runDir, 'profile'));
app.setPath('sessionData', path.join(runDir, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { steps: {}, captures: [], errors: [] };
const CHANGE = 'Skip the migration and add tests first.';

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_wc, _p, done) => done(false));
  const b = screen.getAllDisplays().map(d => d.bounds);
  const win = new BrowserWindow({ width: 1400, height: 860, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: Math.min(...b.map(v => v.x)) - 1600, y: Math.min(...b.map(v => v.y)) - 1100, title: 'Synthetic change plan verification', webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.on('focus', () => { report.errors.push('Verification window took OS focus'); process.exitCode = 1; });
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const capture = async name => { const file = path.join(runDir, name + '.png'); fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG()); report.captures.push(file); };
  // Record every steer/send the renderer makes, and keep them succeeding.
  const PREP = `(() => {
    const n = window.nekko; window.__sent = [];
    const records = window.integration.records();
    const s = records.find(r => r.id === 'existing');
    s.agentPlan = [{ id: 'one', title: 'Inspect the wall layout', status: 'done' }, { id: 'two', title: 'Write the migration', status: 'active' }, { id: 'three', title: 'Add tests', status: 'pending' }];
    const wrap = (k) => { const f = n[k]; return async (...a) => { window.__sent.push({ via: k, text: k === 'steerChat' ? a[1] : a[0]?.text }); return k === 'steerChat' ? { ...s } : f(...a); }; };
    window.nekko = new Proxy(n, { get(t, k) { return k === 'steerChat' || k === 'sendChat' ? wrap(k) : t[k]; } });
  })()`;
  const state = () => run(`({
    pop: !!document.querySelector('[data-plan-change]'),
    popText: document.querySelector('[data-plan-change]')?.innerText?.replace(/\\s+/g, ' ').slice(0, 160) ?? null,
    focusedBox: document.activeElement?.id === 'plan-change-text',
    composer: (document.querySelector('[data-wall-composer] [contenteditable]')?.innerText ?? '').trim().slice(0, 160),
    sent: window.__sent,
  })`);
  const clickChangePlan = () => run(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Change plan'); if (!b) throw Error('no Change plan button'); b.click(); return b.disabled; })()`);
  try {
    await win.loadFile(path.join(out, 'index.html'));
    win.showInactive();
    await sleep(1200);
    await run('window.integration.reset()');
    await sleep(900);
    await run(PREP);
    // The plan only shows once the window re-reads its session: reopen the wall.
    await run(`window.integration.route('chat')`); await sleep(300); await run(`window.integration.route('command')`); await sleep(900);
    await run(`window.integration.theme({})`); // opens the Agent Monitor (planRailOpen)
    await sleep(700);
    report.steps.planShown = await run(`!!document.body.innerText.includes('Write the migration')`);
    await capture('1-plan');
    report.steps.buttonDisabled = await clickChangePlan();
    await sleep(500);
    report.steps.afterClick = await state();
    await capture('2-after-click');
    if (report.steps.afterClick.pop) {
      // Type the change the way React sees it, then press Enter.
      await run(`(() => { const t = document.getElementById('plan-change-text'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, ${JSON.stringify(CHANGE)}); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await sleep(250);
      await capture('3-typed');
      await run(`document.getElementById('plan-change-text').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
      await sleep(600);
      report.steps.afterSend = await state();
      await capture('4-sent');
      // Esc closes it without sending.
      await clickChangePlan(); await sleep(300);
      await run(`document.getElementById('plan-change-text').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      await sleep(300);
      report.steps.afterEscape = await state();
      // While the agent is working, the change steers the running turn.
      await run('window.__work()');
      await sleep(400);
      await clickChangePlan(); await sleep(300);
      report.steps.runningLabel = (await state()).popText;
      await run(`(() => { const t = document.getElementById('plan-change-text'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, 'Use the existing helper instead.'); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await sleep(200);
      await capture('5-running-typed');
      await run(`[...document.querySelectorAll('[data-plan-change] button')].find(b => b.textContent === 'Send change').click()`);
      await sleep(500);
      report.steps.afterRunningSend = await state();
    }
    // The full chat view: the prompt pops up over the chat's own composer.
    await run(`window.integration.state().openChatPane('existing')`);
    await run(`window.integration.route('chat')`);
    await sleep(1200);
    await run(`window.integration.theme({})`);
    await sleep(600);
    report.steps.fullHasButton = await run(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Change plan')`);
    if (report.steps.fullHasButton) {
      await clickChangePlan(); await sleep(400);
      report.steps.fullPop = await run(`(() => { const p = document.querySelector('[data-plan-change-pop]'); const c = document.querySelector('.composer'); if (!p || !c) return { pop: !!p }; const a = p.getBoundingClientRect(), b = c.getBoundingClientRect(); return { pop: true, aboveComposer: a.bottom <= b.top + 2, focusedBox: document.activeElement?.id === 'plan-change-text' }; })()`);
      await capture('6-full-chat');
    }
  } catch (e) {
    report.errors.push(String(e && e.stack || e));
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(report, null, 1));
    console.log(JSON.stringify({ runDir, errors: report.errors, steps: report.steps }, null, 1));
    win.destroy();
    app.quit();
  }
});
