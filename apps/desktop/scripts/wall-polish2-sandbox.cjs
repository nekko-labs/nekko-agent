// Synthetic Agents-wall polish (round two) evidence; never connects to the user's host or profile.
// Launched through wall-polish-integration.cjs with NEKKO_SANDBOX=wall-polish2-sandbox.cjs.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through wall-polish-integration.cjs');
const base = !!process.env.NEKKO_TEST_REVISION;
const dir = path.join(out, base ? 'before2' : 'after2');
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
    x: left - 3000, y: -2000, title: 'Synthetic Agents wall polish 2 verification',
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
    await run('document.getAnimations().filter(a => a instanceof CSSTransition).forEach(a => a.finish())');
    fs.writeFileSync(path.join(dir, name + '.png'), (await win.capturePage(rect, { stayHidden: true, stayAwake: false })).toPNG());
  };
  // Only fixed, known selectors and reset presets reach the page: they are
  // looked up by name there, never interpolated into the evaluated source.
  const SELECTORS = { panel: '[data-agent-panel]', budget: '.monitors-dock__budget', empty: '[data-wall-empty]' };
  const PRESETS = { plain: {}, empty: { empty: true }, horizontal: { horizontal: true }, dock: { dock: true }, spooky: { empty: true, preset: 'autumn' } };
  const rectOf = async (key, pad = 16) => {
    if (!(key in SELECTORS) || !Number.isInteger(pad)) throw Error('unknown selector');
    await run(`window.__sel=${JSON.stringify(Object.values(SELECTORS))}`);
    const index = Object.keys(SELECTORS).indexOf(key);
    return run(`(()=>{const e=document.querySelector(window.__sel[${index}]);if(!e)return undefined;const r=e.getBoundingClientRect();const p=${pad};return {x:Math.max(0,Math.floor(r.x)-p),y:Math.max(0,Math.floor(r.y)-p),width:Math.min(innerWidth,Math.ceil(r.width)+p*2),height:Math.min(innerHeight,Math.ceil(r.height)+p*2)}})()`);
  };
  const reset = async (preset = 'plain') => {
    if (!(preset in PRESETS)) throw Error('unknown preset');
    await run(`window.__presets=${JSON.stringify(Object.values(PRESETS))}`);
    await run(`integration.reset(window.__presets[${Object.keys(PRESETS).indexOf(preset)}])`);
    await sleep(900);
  };
  const theme = (t, preset) => run(`document.documentElement.dataset.theme='${t}';${preset ? `document.documentElement.dataset.preset='${preset}'` : "delete document.documentElement.dataset.preset"}`);
  try {
    await win.loadFile(path.join(out, 'index.html'));
    win.showInactive();
    await sleep(1000);
    for (const t of ['dark', 'light']) {
      // 1. Empty wall.
      await reset('empty'); await theme(t); await sleep(300);
      await check(`empty wall shows the illustration (${t})`, "!!document.querySelector('[data-wall-empty] .wall-empty-art[data-variant=default]')");
      await check(`empty illustration is centred in the wall (${t})`, "(()=>{const a=document.querySelector('.wall-empty-art')?.getBoundingClientRect();const w=document.querySelector('.command-wall-layout').getBoundingClientRect();if(!a)return false;return Math.abs((a.left+a.right)/2-(w.left+w.right)/2)<24 && a.top>w.top+40})()");
      await capture(`empty-${t}`);
      // 2. Vertical agent panel header and frame.
      await reset(); await theme(t);
      await check(`vertical panel has no ring (${t})`, "getComputedStyle(document.querySelector('[data-agent-panel]'),'::after').content==='none'");
      await check(`hide uses the panel icon, not an X (${t})`, "!!document.querySelector('[aria-label=\"Hide the agent panel\"]') && !document.querySelector('[aria-label=\"Close the agent panel\"]')");
      await check(`plus is accent coloured (${t})`, "(()=>{const b=document.querySelector('.agent-panel-plus');const probe=document.createElement('span');probe.style.color='var(--accent)';document.body.append(probe);const ok=getComputedStyle(b).color===getComputedStyle(probe).color;probe.remove();return ok && b.querySelector('svg').getBoundingClientRect().width>=21})()");
      await capture(`panel-vertical-${t}`, await rectOf('panel', 12));
      await capture(`panel-header-${t}`, await run("(()=>{const r=document.querySelector('[data-agent-panel]').getBoundingClientRect();return {x:Math.max(0,Math.floor(r.x)-8),y:Math.max(0,Math.floor(r.y)-8),width:Math.ceil(r.width)+16,height:72}})()"));
      // 3. The + menu over the wall.
      await run("(()=>{const b=document.querySelector('.agent-panel-plus')||[...document.querySelectorAll('[data-agent-panel] button')].find(x=>x.title==='New agent with a terminal');b.dispatchEvent(new MouseEvent('mouseover',{bubbles:true,relatedTarget:document.body}))})()");
      await sleep(400);
      await check(`plus menu is topmost over the wall (${t})`, "(()=>{const m=document.querySelector('[data-new-agent-menu]');if(!m)return false;const r=m.getBoundingClientRect();return [[r.left+20,r.top+20],[r.right-20,r.bottom-20],[r.right-20,r.top+20]].every(([x,y])=>m.contains(document.elementFromPoint(x,y)))})()");
      await capture(`plus-menu-${t}`, { x: 0, y: 0, width: 900, height: 560 });
      // 4. Horizontal panel.
      await reset('horizontal'); await theme(t);
      await check(`horizontal panel has no ring (${t})`, "(()=>{const p=document.querySelector('[data-agent-panel]');return p?.dataset.orientation==='horizontal'&&getComputedStyle(p,'::after').content==='none'})()");
      await capture(`panel-horizontal-${t}`, await rectOf('panel', 12));
      // 5. Add window: centred directly below the wall, above the composer.
      await reset(); await theme(t);
      await check(`add window centred under the wall, above the composer (${t})`, "(()=>{const b=document.querySelector('[data-wall-add-button]')?.getBoundingClientRect();const w=document.querySelector('.command-wall-layout').getBoundingClientRect();const c=document.querySelector('[data-wall-composer]').getBoundingClientRect();if(!b)return false;return Math.abs((b.left+b.right)/2-(w.left+w.right)/2)<4&&b.top>=w.bottom-1&&b.bottom<=c.top+1})()");
      await check(`no elbow arrow (${t})`, "!document.querySelector('.wall-add-arrow')");
      await capture(`wall-${t}`);
      // 6. Budget panel range filters.
      await reset('dock'); await theme(t); await sleep(400);
      await check(`budget has the Insights range filter (${t})`, "(()=>{const g=document.querySelector('[aria-label=\"Budget time range\"]');return !!g&&[...g.querySelectorAll('button')].map(b=>b.textContent).join()==='today,1wk,1m,6m,1y,all-time'})()");
      await capture(`budget-1m-${t}`, await rectOf('budget', 12));
      await run("[...document.querySelectorAll('[aria-label=\"Budget time range\"] button')].find(b=>b.textContent==='all-time')?.click()"); await sleep(300);
      await check(`budget all-time includes older usage (${t})`, "document.querySelector('.monitors-dock__budget').textContent.includes('492,000 in')");
      await capture(`budget-all-${t}`, await rectOf('budget', 12));
    }
    // Spooky empty wall.
    await reset('spooky'); await theme('dark', 'autumn'); await sleep(300);
    await check('spooky empty wall variant', "!!document.querySelector('.wall-empty-art[data-variant=spooky] [data-part=spooky]')");
    await capture('empty-spooky-dark');
    await capture('empty-spooky-art', await rectOf('empty', 24));
    await reset('empty'); await theme('dark'); await sleep(300);
    await capture('empty-art-dark', await rectOf('empty', 24));
    if (win.isFocused()) throw Error('Fixture focus invariant failed');
    report.background = { visible: win.isVisible(), focused: win.isFocused(), bounds: win.getBounds() };
    report.success = !report.errors.some(e => /focus/.test(e)) && (base || report.checks.every(c => c.passed));
  } catch (error) {
    report.errors.push(String(error)); report.success = false;
  } finally {
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ dir, success: report.success, failed: report.checks.filter(c => !c.passed).map(c => c.name), errors: report.errors.slice(0, 8) }, null, 2));
    win.destroy(); app.exit(report.success ? 0 : 1);
  }
});
