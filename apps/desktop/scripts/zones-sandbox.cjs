// Hidden full-App evidence for Dynamic zones and the zones intro. No host, network or user profile.
// NEKKO_TEST_BASELINE=1 captures only the starting board (for a run against main).
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { assertions: [], errors: [], captures: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: Number(process.env.NEKKO_TEST_WIDTH || 1440), height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -1700, y: -1100, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const run = s => win.webContents.executeJavaScript(s, true);
  const png = async file => fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG());
  const shot = async name => { const file = path.join(out, name + '.png'); await png(file); report.captures.push(file); };
  const frames = async (dir, count, every) => { fs.mkdirSync(path.join(out, dir), { recursive: true }); for (let i = 0; i < count; i++) { await png(path.join(out, dir, String(i).padStart(3, '0') + '.png')); await sleep(every); } };
  const check = async (name, expr) => { const passed = !!await run(expr); report.assertions.push({ name, passed }); if (!passed) throw Error(name); };
  const center = async sel => run(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  const zones = `Array.from(document.querySelectorAll('[data-zone]')).map(e => (e.dataset.zone || '') + ':' + e.dataset.gridCell)`;
  win.on('focus', () => report.errors.push('took focus'));
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 60 && !await run('!!window.layoutFixture && !!document.querySelector("[data-command-wall]")'); i++) await sleep(200);
    // A board from before zones: every chat opened on it.
    await run(`localStorage.setItem('nekko.commandWall',JSON.stringify({layout:{mode:'grid',cols:2,rows:2},root:{id:'split_fixture',dir:'col',sizes:[0.5,0.5],children:[{id:'split_r1',dir:'row',sizes:[0.5,0.5],children:[{id:'pane_a',kind:'chat',refId:'a'},{id:'pane_b',kind:'chat',refId:'b'}]},{id:'split_r2',dir:'row',sizes:[0.5,0.5],children:[{id:'pane_c',kind:'chat',refId:'c'},{id:'pane_d',kind:'chat',refId:'d'}]}]},watermark:Date.now(),autoAdd:true,hero:'a'})); location.reload()`);
    await sleep(2500);
    if (process.env.NEKKO_TEST_BASELINE === '1') {
      await check('baseline shows every chat', `document.querySelectorAll('[data-grid-cell^="chat:"]').length === 4`);
      await shot('board');
      // The same three-across row the zones board reaches with one added zone, for comparing narrow windows.
      await run(`localStorage.setItem('nekko.commandWall',JSON.stringify({layout:{mode:'grid',cols:3,rows:1},root:{id:'split_fixture',dir:'row',sizes:[1/3,1/3,1/3],children:[{id:'pane_a',kind:'chat',refId:'a'},{id:'pane_b',kind:'chat',refId:'b'},{id:'pane_c',kind:'chat',refId:'c'}]},watermark:Date.now(),autoAdd:false,hero:'a'})); location.reload()`);
      await sleep(2500);
      await shot('board-three');
    } else {
      // Migration: two zones, the two newest agents; the intro is up.
      await check('migrated to two zones', `${zones}.join('|') === 'Zone 1:chat:a|Zone 2:chat:b'`);
      await check('others stay incomplete', "layoutFixture.records.every(s => !s.archivedAt)");
      for (let i = 0; i < 40 && !await run('!!document.querySelector(".zones-intro canvas, .zones-intro [data-zones-intro-step] div")'); i++) await sleep(200);
      await check('intro shown', `!!document.querySelector('.zones-intro')`);
      await sleep(1800);
      await shot('intro-1');
      await frames('intro-1-motion', 30, 200);
      await run(`Array.from(document.querySelectorAll('.zones-intro button')).find(b => b.textContent === 'Next').click()`);
      await sleep(2200); await shot('intro-2');
      await frames('intro-2-motion', 30, 200);
      await run(`Array.from(document.querySelectorAll('.zones-intro button')).find(b => b.textContent === 'Next').click()`);
      await sleep(2200); await shot('intro-3');
      await frames('intro-3-motion', 32, 200);
      await run(`Array.from(document.querySelectorAll('.zones-intro button')).find(b => b.textContent === 'Get started').click()`);
      await sleep(600);
      await check('intro closes and is remembered', `!document.querySelector('.zones-intro') && JSON.parse(localStorage.getItem('nekko.commandWall')).zonesIntro === true`);
      await shot('zones-start');

      // The right rail's plus previews, then adds, a zone in that row.
      const plus = await center('.wall-zone-rail[data-side="right"] .wall-zone-add');
      win.webContents.sendInputEvent({ type: 'mouseMove', x: plus.x, y: plus.y });
      await sleep(300);
      await check('hover previews the new zone', `!!document.querySelector('.wall-zone-ghost')`);
      await shot('rail-hover');
      await run(`document.querySelector('.wall-zone-rail[data-side="right"] .wall-zone-add').click()`);
      await sleep(500);
      await check('third zone fits the row', `${zones}.join('|') === 'Zone 1:chat:a|Zone 2:chat:b|Zone 3:zone:'`);
      await check('new zone is active and dotted', `!!document.querySelector('[data-zone="Zone 3"][data-zone-active] [data-zone-empty]')`);
      win.webContents.sendInputEvent({ type: 'mouseMove', x: 700, y: 500 });
      await sleep(300);
      await shot('three-zones');

      // Bottom rail: one plus per column, and one spanning the full width.
      const span = await center('.wall-zone-rail[data-side="down"] .wall-zone-add');
      win.webContents.sendInputEvent({ type: 'mouseMove', x: span.x, y: span.y });
      await sleep(300);
      await shot('bottom-rail-hover');
      win.webContents.sendInputEvent({ type: 'mouseMove', x: 700, y: 500 });

      // Clicking an agent in the panel puts it in the active (empty) zone.
      await run(`Array.from(document.querySelectorAll('[data-agent-panel] [role=button]')).find(e => e.textContent.includes('Audit sandbox policy')).click()`);
      await sleep(700);
      await check('panel click fills the active zone', `${zones}.join('|') === 'Zone 1:chat:a|Zone 2:chat:b|Zone 3:chat:c'`);
      await shot('panel-click');

      // Clicking zone 1 makes it active; a panel click there trades it with the agent already in zone 3.
      const z1 = await center('[data-zone="Zone 1"] .wall-zone-header');
      win.webContents.sendInputEvent({ type: 'mouseDown', x: z1.x, y: z1.y, button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x: z1.x, y: z1.y, button: 'left', clickCount: 1 });
      await sleep(300);
      await check('click activates zone 1', `!!document.querySelector('[data-zone="Zone 1"][data-zone-active]')`);
      await run(`Array.from(document.querySelectorAll('[data-agent-panel] [role=button]')).find(e => e.textContent.includes('Audit sandbox policy')).click()`);
      await sleep(600);
      await check('an agent already on the board trades places', `${zones}.join('|') === 'Zone 1:chat:c|Zone 2:chat:b|Zone 3:chat:a'`);

      // Minimizing an agent keeps its zone, dotted.
      await run(`document.querySelector('[data-zone="Zone 2"] [aria-label^="Minimize"], [data-zone="Zone 2"] [title^="Minimize"]').click()`);
      await sleep(600);
      await check('minimize leaves an empty zone', `${zones}.join('|') === 'Zone 1:chat:c|Zone 2:zone:|Zone 3:chat:a'`);
      await check('minimized chat is not completed', "layoutFixture.records.every(s => !s.archivedAt)");
      await shot('minimized');

      // Drag an agent row from the panel into the empty zone: the chip flies in and grows.
      await run(`(() => {
        const row = Array.from(document.querySelectorAll('[data-agent-panel] [data-completion-row]')).find(e => e.textContent.includes('Diagnose failed build'));
        const r = row.getBoundingClientRect();
        window.__dt = new DataTransfer();
        window.__row = row;
        row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: window.__dt, clientX: r.left + 30, clientY: r.top + 12 }));
      })()`);
      const target = await center('[data-zone="Zone 2"]');
      const start = await run(`(() => { const r = window.__row.getBoundingClientRect(); return { x: r.left + 30, y: r.top + 12 }; })()`);
      fs.mkdirSync(path.join(out, 'drag-in'), { recursive: true });
      for (let i = 0; i <= 12; i++) {
        const t = i / 12;
        const x = Math.round(start.x + (target.x - start.x) * t), y = Math.round(start.y + (target.y - start.y) * t);
        await run(`(() => { const el = document.elementFromPoint(${x}, ${y}) || document.body; el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: window.__dt, clientX: ${x}, clientY: ${y} })); })()`);
        await sleep(30);
        await png(path.join(out, 'drag-in', String(i).padStart(3, '0') + '.png'));
      }
      await check('zone highlights under the chip', `!!document.querySelector('[data-zone="Zone 2"][data-zone-drop]')`);
      await shot('drag-over');
      await run(`(() => { const el = document.elementFromPoint(${target.x}, ${target.y}); el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__dt, clientX: ${target.x}, clientY: ${target.y} })); window.__row.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: window.__dt })); })()`);
      for (let i = 13; i < 30; i++) { await png(path.join(out, 'drag-in', String(i).padStart(3, '0') + '.png')); await sleep(35); }
      await sleep(400);
      await check('drop fills the zone and makes it active', `${zones}.join('|') === 'Zone 1:chat:c|Zone 2:chat:b|Zone 3:chat:a' && !!document.querySelector('[data-zone="Zone 2"][data-zone-active]')`);
      await check('chip is gone after landing', `!document.querySelector('.wall-agent-chip')`);
      await shot('dropped');

      // Pick zone 3 up by its name bar and hold it at the bottom edge: fits the column, Shift spans.
      const z3 = await center('[data-zone="Zone 3"] .wall-zone-header');
      const stage = await run(`(() => { const r = document.querySelector('.command-wall-pane-stage').getBoundingClientRect(); return { left: r.left, right: r.right, bottom: r.bottom }; })()`);
      win.webContents.sendInputEvent({ type: 'mouseDown', x: z3.x, y: z3.y, button: 'left', clickCount: 1 });
      await sleep(250);
      const edge = { x: Math.round(stage.left + 200), y: Math.round(stage.bottom - 4) };
      for (let i = 1; i <= 6; i++) { win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(z3.x + (edge.x - z3.x) * i / 6), y: Math.round(z3.y + (edge.y - z3.y) * i / 6) }); await sleep(40); }
      await sleep(350);
      await check('edge drop offers the column with a Shift hint', `document.querySelector('.wall-span-hint')?.textContent.startsWith('Hold Shift')`);
      await shot('edge-fit');
      win.webContents.sendInputEvent({ type: 'mouseMove', x: edge.x, y: edge.y + 1, modifiers: ['shift'] });
      await sleep(350);
      await check('Shift spans the full width', `document.querySelector('.wall-span-hint')?.textContent.startsWith('Spans the full width')`);
      await shot('edge-span');
      win.webContents.sendInputEvent({ type: 'mouseUp', x: edge.x, y: edge.y + 1, button: 'left', clickCount: 1, modifiers: ['shift'] });
      await sleep(500);
      await check('dropped as a full-width row', `(() => { const r = document.querySelector('[data-zone="Zone 3"]').getBoundingClientRect(), s = document.querySelector('.command-wall-pane-stage').getBoundingClientRect(); return r.width > s.width - 20; })()`);
      await shot('spanned');

      // Right-click a name bar to close the zone.
      const z2 = await center('[data-zone="Zone 2"] .wall-zone-header');
      win.webContents.sendInputEvent({ type: 'mouseDown', x: z2.x, y: z2.y, button: 'right', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'contextMenu', x: z2.x, y: z2.y });
      win.webContents.sendInputEvent({ type: 'mouseUp', x: z2.x, y: z2.y, button: 'right', clickCount: 1 });
      await sleep(300);
      await check('zone menu offers Close zone', `Array.from(document.querySelectorAll('[role=menuitem]')).some(e => e.textContent === 'Close zone')`);
      await shot('zone-menu');
      await run(`Array.from(document.querySelectorAll('[role=menuitem]')).find(e => e.textContent === 'Close zone').click()`);
      await sleep(600);
      await check('zone closed, agent kept', `!document.querySelector('[data-zone="Zone 2"]') && layoutFixture.records.every(s => !s.archivedAt)`);
      await shot('closed');
    }
    report.bounds = win.getBounds(); report.hidden = !win.isVisible();
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ assertions: report.assertions, errors: report.errors, bounds: report.bounds, hidden: report.hidden }, null, 2));
  win.destroy(); app.exit(report.errors.length ? 1 : 0);
});
