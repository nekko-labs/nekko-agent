// Synthetic question / plan toggle / dock sign-in evidence; never connects to the user's host or profile.
// Launched through wall-polish-integration.cjs with NEKKO_SANDBOX=wall-polish4-sandbox.cjs.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through wall-polish-integration.cjs');
const base = !!process.env.NEKKO_TEST_REVISION;
const dir = path.join(out, base ? 'before4' : 'after4');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
app.setPath('userData', path.join(dir, 'profile'));
app.setPath('sessionData', path.join(dir, 'profile'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((request, done) => done({ cancel: !/^(file:|data:|blob:)/.test(request.url) }));
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, done) => done(false));
  const left = Math.min(...screen.getAllDisplays().map(d => d.bounds.x));
  const win = new BrowserWindow({
    width: 1400, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true,
    x: left - 3000, y: -2000, title: 'Synthetic question, plan toggle and dock sign-in verification',
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  const report = { checks: [], errors: [], visuallyInspected: false };
  win.on('focus', () => report.errors.push('Fixture took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push('console: ' + e.message); });
  const run = source => win.webContents.executeJavaScript(source, true);
  const check = async (name, source) => {
    await sleep(150);
    let ok = false;
    try { ok = !!await run(source); } catch (e) { report.errors.push(name + ': ' + e); }
    report.checks.push({ name, passed: ok });
  };
  const capture = async (name, rect) => {
    await sleep(350);
    await run('document.getAnimations().forEach(a => { try { a.finish(); } catch {} })');
    fs.writeFileSync(path.join(dir, name + '.png'), (await win.capturePage(rect || undefined, { stayHidden: true, stayAwake: false })).toPNG());
  };
  // Only fixed selectors and presets reach the page, looked up by index there.
  const SELECTORS = { beta: '[data-grid-cell="chat:beta"]', alpha: '[data-grid-cell="chat:alpha"]', dock: '.monitors-dock__utilization' };
  const PRESETS = { question: { question: true }, plan: { plan: true, planOpen: true }, planFocus: { plan: true, planOpen: true, focus: true }, planClosedFocus: { plan: true, focus: true }, expired: { expired: true } };
  const rectOf = async (key, pad = 12) => {
    if (!(key in SELECTORS) || !Number.isInteger(pad)) throw Error('unknown selector');
    await run(`window.__sel=${JSON.stringify(Object.values(SELECTORS))}`);
    const index = Object.keys(SELECTORS).indexOf(key);
    return run(`(()=>{const e=document.querySelector(window.__sel[${index}]);if(!e)return undefined;const r=e.getBoundingClientRect();const p=${pad};return {x:Math.max(0,Math.floor(r.x)-p),y:Math.max(0,Math.floor(r.y)-p),width:Math.min(innerWidth,Math.ceil(r.width)+p*2),height:Math.min(innerHeight,Math.ceil(r.height)+p*2)}})()`);
  };
  const reset = async (preset) => {
    if (!(preset in PRESETS)) throw Error('unknown preset');
    await run(`window.__presets=${JSON.stringify(Object.values(PRESETS))}`);
    await run(`integration.reset(window.__presets[${Object.keys(PRESETS).indexOf(preset)}])`);
    await sleep(1200);
  };
  const theme = t => run(`document.documentElement.dataset.theme='${t === 'light' ? 'light' : 'dark'}'`);
  try {
    await win.loadFile(path.join(out, 'index.html'));
    win.showInactive();
    await sleep(1000);
    for (const t of ['dark', 'light']) {
      // 1. Question: pinned at the top of the window, warning-toned, label visible.
      await reset('question'); await theme(t); await sleep(400);
      await check(`question pinned above the transcript (${t})`, "(()=>{const w=document.querySelector('[data-grid-cell=\"chat:beta\"]');const q=w&&w.querySelector('[data-agent-question]');const tr=w&&w.querySelector('[data-question-tone]');if(!q||!tr)return false;const content=w.querySelector('.command-wall-content').getBoundingClientRect();return q.getBoundingClientRect().top-content.top<60})()");
      await check(`'Asked you a question' is visible (${t})`, "(()=>{const l=[...document.querySelectorAll('[data-grid-cell=\"chat:beta\"] *')].find(e=>e.children.length<=1&&/^\\s*Asked you a question\\s*$/.test(e.textContent));if(!l)return false;const r=l.getBoundingClientRect();if(r.height<8)return false;const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return !!hit&&(l===hit||l.contains(hit)||hit.contains(l))})()");
      await check(`question card wears the warning tone (${t})`, "document.querySelector('[data-grid-cell=\"chat:beta\"] [data-question-tone]')?.dataset.questionTone==='attention'");
      await capture(`question-${t}`);
      await capture(`question-window-${t}`, await rectOf('beta', 10));
      // 2. Plan: floating toggle, panel on, no X; closes and reopens.
      await reset('planFocus'); await theme(t); await sleep(400);
      await check(`plan panel on by default in a wide window (${t})`, "!!document.querySelector('[data-grid-cell=\"chat:alpha\"] aside[aria-label=\"Plan and sub-agents\"]')");
      await check(`plan panel has no X (${t})`, "!document.querySelector('[aria-label=\"Hide the plan panel\"][title=\"Hide the plan panel\"] svg path[d=\"M18 6 6 18M6 6l12 12\"]')");
      await check(`plan toggle floats top-right of the chat area (${t})`, "(()=>{const w=document.querySelector('[data-grid-cell=\"chat:alpha\"]');const b=w&&w.querySelector('[data-plan-toggle]');if(!b)return false;const area=b.parentElement.getBoundingClientRect();const r=b.getBoundingClientRect();return getComputedStyle(b).position==='absolute'&&area.right-r.right<24&&r.top-area.top<24})()");
      await capture(`plan-open-${t}`, await rectOf('alpha', 6));
      await run("document.querySelector('[data-grid-cell=\"chat:alpha\"] [data-plan-toggle]')?.click()"); await sleep(400);
      await check(`plan toggle hides the panel (${t})`, "!document.querySelector('[data-grid-cell=\"chat:alpha\"] aside[aria-label=\"Plan and sub-agents\"]')&&!!document.querySelector('[data-grid-cell=\"chat:alpha\"] [data-plan-toggle][aria-pressed=\"false\"]')");
      await capture(`plan-closed-${t}`, await rectOf('alpha', 6));
      await run("document.querySelector('[data-grid-cell=\"chat:alpha\"] [data-plan-toggle]')?.click()"); await sleep(400);
      // A narrow (Dynamic, two across at 1400px is ~600px) window keeps the panel only if it has room.
      await reset('plan'); await theme(t); await sleep(400);
      report[`planDebug-${t}`] = await run("(()=>{const w=document.querySelector('[data-grid-cell=\"chat:alpha\"]');return {w:Math.round(w.getBoundingClientRect().width),rail:!!w.querySelector('aside[aria-label=\"Plan and sub-agents\"]'),toggle:!!w.querySelector('[data-plan-toggle]')}})()");
      await capture(`plan-dynamic-${t}`);
      // 3. Dock: Sign in again right in Utilization.
      await reset('expired'); await theme(t); await sleep(800);
      await check(`utilization offers Sign in again inline (${t})`, "(()=>{const d=document.querySelector('.monitors-dock__utilization');return !!d&&!!d.querySelector('[data-dock-signin] button')&&/Sign in again/.test(d.textContent)&&!/in Settings/.test(d.textContent)})()");
      await capture(`dock-signin-${t}`, await rectOf('dock', 8));
      await run("document.querySelector('[data-dock-signin] button')?.click()"); await sleep(400);
      await check(`Sign in again opens the sign-in flow (${t})`, "/Sign in with Claude/.test(document.querySelector('[data-dock-signin]')?.textContent||'')");
      await capture(`dock-signin-open-${t}`, await rectOf('dock', 8));
    }
    if (win.isFocused()) throw Error('Fixture focus invariant failed');
    report.background = { visible: win.isVisible(), focused: win.isFocused(), bounds: win.getBounds() };
    report.success = !report.errors.some(e => /focus/.test(e)) && (base || report.checks.every(c => c.passed));
  } catch (error) {
    report.errors.push(String(error)); report.success = false;
  } finally {
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ dir, success: report.success, failed: report.checks.filter(c => !c.passed).map(c => c.name), errors: report.errors.slice(0, 8), plan: [report['planDebug-dark'], report['planDebug-light']] }, null, 2));
    win.destroy(); app.exit(report.success ? 0 : 1);
  }
});
