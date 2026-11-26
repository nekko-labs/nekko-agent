// Chat groups evidence: the + menu, the colour picker, empty buckets, clusters,
// Done without checks, archived clusters, menus, a sub-agent row and a drag-over,
// in dark and light. Synthetic chats only; hidden, off-screen, non-focusable,
// isolated profile. Launch through layout-evidence-integration.cjs with
// NEKKO_LAYOUT_FIXTURE=chat-groups-fixture.tsx and NEKKO_LAYOUT_SANDBOX=chat-groups-sandbox.cjs.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');
// Values put into page code: JSON, with the characters that could end a script or a line escaped.
const js = (v) => JSON.stringify(v).replace(/[<>/\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], errors: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const minX = Math.min(...screen.getAllDisplays().map(d => d.bounds.x)), minY = Math.min(...screen.getAllDisplays().map(d => d.bounds.y));
  const win = new BrowserWindow({ width: 800, height: 1500, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: minX - 2000, y: minY - 1700, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const rectOf = sel => run(`(() => { const e = document.querySelector(${js(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
  const pad = (r, p = 12) => { const x = Math.max(0, Math.floor(r.x - p)), y = Math.max(0, Math.floor(r.y - p)); return { x, y, width: Math.ceil(r.width + 2 * p), height: Math.ceil(r.height + 2 * p) }; };
  const union = (...rs) => { const x = Math.min(...rs.map(r => r.x)), y = Math.min(...rs.map(r => r.y)); return { x, y, width: Math.max(...rs.map(r => r.x + r.width)) - x, height: Math.max(...rs.map(r => r.y + r.height)) - y }; };
  let theme = 'dark';
  const shot = async (name, rect) => {
    await sleep(500);
    const f = path.join(out, `${name}-${theme}.png`);
    fs.writeFileSync(f, (await win.capturePage(rect, { stayHidden: true, stayAwake: false })).toPNG());
    report.captures.push(f);
  };
  const click = sel => run(`document.querySelector(${js(sel)}).click()`);
  const contextMenuAt = (sel) => run(`(() => { const e = document.querySelector(${js(sel)}); const r = e.getBoundingClientRect(); e.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 40, clientY: r.y + r.height / 2 })); })()`);
  const clickText = (scope, text) => run(`(() => { const b = [...document.querySelectorAll(${js(scope)} + ' button, ' + ${js(scope)} + ' [role=menuitem]')].find(x => x.textContent.trim() === ${js(text)}); if (!b) throw Error('no ' + ${js(text)}); b.click(); })()`);
  const closeMenus = async () => { await run(`document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`); await sleep(300); };
  const load = async (query) => { await win.loadFile(path.join(out, 'index.html'), { search: query }); for (let i = 0; i < 60 && !(await run("!!document.querySelector('[data-agent-group]')")); i++) await sleep(200); await sleep(800); };
  const hoverPlus = async () => {
    const r = await rectOf('[aria-label="New agent"]');
    win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
    await run(`document.querySelector('[aria-label="New agent"]').dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }))`);
    await sleep(500);
  };
  const type = (sel, value) => run(`(() => { const i = document.querySelector(${js(sel)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${js(value)}); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  try {
    for (theme of ['dark', 'light']) {
      const q = `?theme=${theme}`;
      await load(`${q}&plain=1`);
      await shot('01-before-no-chat-groups', await rectOf('[data-agent-panel]').then(r => pad(r, 0)));

      await load(q);
      const panel = pad(await rectOf('[data-agent-panel]'), 0);
      // 2: the + menu with New group, then its name field.
      await hoverPlus();
      await shot('02-plus-menu-new-group', union(pad(await rectOf('[data-new-agent-menu]'), 16), { x: 0, y: 0, width: 520, height: 60 }));
      await click('[data-new-group-row]'); await sleep(400);
      await type('input[aria-label="New group name"]', 'Release prep'); await sleep(300);
      await shot('03-plus-menu-name-field-picker-collapsed', pad(await rectOf('[data-new-agent-menu]'), 16));
      // 4: expanded picker.
      await click('[data-chat-group-custom]'); await sleep(500);
      await type('input[aria-label="Group colour hex"]', '#e0457b'); await sleep(400);
      await shot('04-picker-expanded-wheel-bar-hex-save', pad(await rectOf('[data-new-agent-menu]'), 16));
      await closeMenus();
      await load(q);

      // 5: an empty bucket, then clusters in the status groups.
      const bucket = await rectOf('[data-chat-group-empty="Docs"]');
      await shot('05-empty-bucket-drag-chats-here', pad(union(bucket, await rectOf('[data-chat-group-empty="Design review"]')), 12));
      await shot('06-clusters-in-status-groups', { x: 0, y: 0, width: Math.ceil(panel.width + 24), height: 1100 });
      await shot('07-done-group-no-check', pad(await rectOf('[data-agent-group="status:done"]'), 12));
      // 11: a sub-agent row, check at the end.
      await shot('08-sub-agent-done-check-at-end', pad(await rectOf('[data-subagent-list]'), 24));

      // 9: the chat right-click menu, Move to group.
      await contextMenuAt('[data-archive-row="d4"]'); await sleep(400);
      await clickText('[role=menu]', 'Move to group'); await sleep(400);
      await shot('09-move-to-group-menu-colour-dots', pad(await rectOf('[role=menu]'), 16));
      await closeMenus();
      // 10: the group heading menu.
      await contextMenuAt('[data-agent-group="status:done"] [data-chat-group-heading]'); await sleep(400);
      await shot('10-group-heading-menu-rename-colour-delete', pad(await rectOf('[role=menu]'), 16));
      await clickText('[role=menu]', 'Colour'); await sleep(400);
      await shot('11-group-heading-colour-picker', pad(await rectOf('[role=menu]'), 16));
      await closeMenus();

      // 12: a drop highlight on a group while a chat is dragged over it.
      await run(`(() => { const dt = new DataTransfer(); dt.setData('application/x-nekko-agent', js({ kind: 'chat', id: 'd4' })); const t = document.querySelector('[data-agent-group="status:building"] [data-chat-group-cluster="API"]'); t.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt })); })()`);
      await sleep(300);
      await shot('12-drag-over-highlight-on-a-group', pad(await rectOf('[data-agent-group="status:building"]'), 12));
      await run(`document.querySelector('[data-agent-group="status:building"] [data-chat-group-cluster="API"]').dispatchEvent(new DragEvent('dragleave', { bubbles: true, relatedTarget: document.body }))`);

      // 7: the archived list, clustered, with dots.
      await click('[data-agent-group="__archived"] [data-sidebar-group]'); await sleep(500);
      await shot('13-archived-list-clustered-with-dots', pad(await rectOf('[data-agent-group="__archived"]'), 12));
    }
  } catch (e) { report.errors.push(String(e && e.stack || e)); process.exitCode = 1; }
  fs.writeFileSync(path.join(out, 'report.json'), js(report, null, 2));
  console.log(js(report, null, 2));
  app.quit();
});
