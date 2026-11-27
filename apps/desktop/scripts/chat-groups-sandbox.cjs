// Chat groups evidence: clusters, tags on cards, the Groups and Tags picker, the create
// form and colour picker, the menus, the header crumb, the composer button, empty
// buckets and a drag-over, in the default (dark) theme; NEKKO_THEMES=dark,light adds light. Synthetic chats only; hidden, off-screen, non-focusable,
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
    win.webContents.invalidate();
    await run('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
    await sleep(300);
    const f = path.join(out, `${name}-${theme}.png`);
    fs.writeFileSync(f, (await win.capturePage(rect, { stayHidden: true, stayAwake: false })).toPNG());
    report.captures.push(f);
  };
  const click = sel => run(`document.querySelector(${js(sel)}).click()`);
  const contextMenuAt = (sel) => run(`(() => { const e = document.querySelector(${js(sel)}); const r = e.getBoundingClientRect(); e.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 40, clientY: r.y + r.height / 2 })); })()`);
  const clickText = (scope, text) => run(`(() => { const b = [...document.querySelectorAll(${js(scope)} + ' button, ' + ${js(scope)} + ' [role=menuitem]')].find(x => x.textContent.trim() === ${js(text)}); if (!b) throw Error('no ' + ${js(text)}); b.click(); })()`);
  const closeMenus = async () => { await run(`document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`); await sleep(300); };
  const load = async (query) => { await win.loadFile(path.join(out, 'index.html'), { search: query }); await sleep(300); for (let i = 0; i < 60 && !(await run("!!document.querySelector('[data-agent-group]')")); i++) await sleep(200); await sleep(800); };
  const hoverPlus = async () => {
    const r = await rectOf('[aria-label="New agent"]');
    win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
    await run(`document.querySelector('[aria-label="New agent"]').dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }))`);
    await sleep(500);
  };
  const type = (sel, value) => run(`(() => { const i = document.querySelector(${js(sel)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${js(value)}); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  try {
    for (theme of (process.env.NEKKO_THEMES || 'dark').split(',')) {
      const q = `?theme=${theme}`;
      await load(`${q}&plain=1`);
      await shot('01-before-no-chat-groups', await rectOf('[data-agent-panel]').then(r => pad(r, 0)));

      await load(q); await sleep(1500);
      const panel = pad(await rectOf('[data-agent-panel]'), 0);
      // The sidebar with named and unnamed clusters, recency inside each, tags on cards.
      await shot('02-sidebar-clusters-named-and-unnamed', { x: 0, y: 0, width: Math.ceil(panel.width + 24), height: 1100 });
      await shot('03-tags-on-cards-with-plus-n', pad(await rectOf('[data-agent-group="status:building"]'), 12));
      await shot('04-done-group-clusters-recency', pad(await rectOf('[data-agent-group="status:done"]'), 12));
      await shot('05-empty-bucket-drag-chats-here', pad(union(await rectOf('[data-chat-group-empty="Docs"]'), await rectOf('[data-chat-group-empty="Design review"]')), 12));
      await shot('06-sub-agent-done-check-at-end', pad(await rectOf('[data-subagent-list]'), 24));

      // The chat's right-click menu, then the Groups and Tags picker from it.
      await contextMenuAt('[data-archive-row="b2"]'); await sleep(400);
      await shot('07-chat-right-click-groups-and-tags', pad(await rectOf('[role=menu].context-menu'), 16));
      await clickText('[role=menu].context-menu', 'Groups and Tags'); await sleep(500);
      await shot('08-picker-groups-tags-checks', pad(await rectOf('[role=menu].context-menu'), 16));
      await run(`document.querySelector('.chat-picker-list').scrollTop = 1000`); await sleep(300);
      await shot('08b-picker-tags-section-checks', pad(await rectOf('[role=menu].context-menu'), 16));
      await type('input[data-chat-picker-search]', 'ur'); await sleep(400);
      await shot('09-picker-search', pad(await rectOf('[role=menu].context-menu'), 16));
      await type('input[data-chat-picker-search]', ''); await sleep(300);
      await click('[data-picker-create]'); await sleep(500);
      await shot('10-picker-create-form-colour-collapsed', pad(await rectOf('[role=menu].context-menu'), 16));
      await click('[data-chat-group-custom]'); await sleep(500);
      await type('input[aria-label="Group colour hex"]', '#e0457b'); await sleep(400);
      await shot('11-picker-create-form-colour-wheel-open', pad(await rectOf('[role=menu].context-menu'), 16));
      await closeMenus();
      await load(q);

      // The + menu's New group form.
      await hoverPlus();
      await click('[data-new-group-row]'); await sleep(600);
      await type('input[aria-label="Group name (optional)"]', 'Release prep'); await sleep(300);
      await shot('12-new-group-form-colour-collapsed', pad(await rectOf('[data-new-agent-menu]'), 16));
      await closeMenus();
      await load(q);

      // The group heading menu and the Edit group form, prefilled.
      await contextMenuAt('[data-agent-group="status:building"] [data-chat-group-heading]'); await sleep(400);
      await shot('13-group-heading-menu-edit-delete', pad(await rectOf('[role=menu].context-menu'), 16));
      await clickText('[role=menu].context-menu', 'Edit group'); await sleep(500);
      await shot('14-edit-group-form-prefilled', pad(await rectOf('[role=menu].context-menu'), 16));
      await closeMenus();

      // A drop highlight on a group while a chat is dragged over it.
      await run(`(() => { const dt = new DataTransfer(); dt.setData('application/x-nekko-agent', JSON.stringify({ kind: 'chat', id: 'd4' })); const t = document.querySelector('[data-agent-group="status:building"] [data-chat-group-cluster="API"]'); t.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt })); })()`);
      await sleep(300);
      await shot('15-drag-over-highlight-on-a-group', pad(await rectOf('[data-agent-group="status:building"]'), 12));
      await run(`document.querySelector('[data-agent-group="status:building"] [data-chat-group-cluster="API"]').dispatchEvent(new DragEvent('dragleave', { bubbles: true, relatedTarget: document.body }))`);

      // The archived list, clustered.
      await click('[data-agent-group="__archived"] [data-sidebar-group]'); await sleep(500);
      await shot('16-archived-list-clustered', pad(await rectOf('[data-agent-group="__archived"]'), 12));

      // The chat header's crumb: a named group in its colour, an unnamed group's dot.
      await load(`${q}&view=header`);
      await shot('17-header-breadcrumb-named-and-unnamed-group', pad(union(await rectOf('[data-crumb-strip="h1"]'), await rectOf('[data-crumb-strip="h2"]')), 16));

      // The composer button on a new chat: empty, picker open, a held choice.
      await load(`${q}&view=composer`);
      await shot('18-composer-button-empty', pad(await rectOf('[data-composer-bar]'), 16));
      await click('[data-chat-group-tag-button]'); await sleep(600);
      await shot('19-composer-picker-open', pad(union(await rectOf('[data-composer-bar]'), await rectOf('[data-chat-group-tag-popover]')), 16));
      await click('[data-picker-group]'); await sleep(400);
      if (await rectOf('[data-chat-group-tag-popover]')) {
        await run(`document.querySelector('[data-picker-tag="urgent"]')?.click()`); await sleep(300);
      } else {
        await click('[data-chat-group-tag-button]'); await sleep(500);
        await click('[data-picker-tag="urgent"]'); await sleep(300);
      }
      await closeMenus();
      await shot('20-composer-button-with-held-choice', pad(await rectOf('[data-composer-bar]'), 16));
    }
  } catch (e) { report.errors.push(String(e && e.stack || e)); process.exitCode = 1; }
  fs.writeFileSync(path.join(out, 'report.json'), js(report, null, 2));
  console.log(js(report, null, 2));
  app.quit();
});
