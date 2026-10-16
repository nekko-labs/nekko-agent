// Synthetic sidebar regression/evidence fixture; never connects to the user's host.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through agent-sidebar-integration.cjs');
const base = !!process.env.NEKKO_TEST_REVISION;
const dir = path.join(out, base ? 'before' : 'after');
fs.mkdirSync(dir, { recursive: true });
app.setPath('userData', path.join(dir, 'profile'));
app.setPath('sessionData', path.join(dir, 'profile'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((request, done) => done({ cancel: !/^(file:|data:|blob:)/.test(request.url) }));
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, done) => done(false));
  const win = new BrowserWindow({
    width: 1200, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true,
    x: Math.min(...screen.getAllDisplays().map(display => display.bounds.x)) - 1600, y: -1600,
    title: 'Synthetic Agents sidebar verification',
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  const report = { checks: [], errors: [], visuallyInspected: false };
  win.on('focus', () => report.errors.push('Fixture took focus'));
  const run = source => win.webContents.executeJavaScript(source, true);
  const check = async (name, source) => {
    await sleep(250);
    if (!await run(source)) throw Error(name);
    report.checks.push(name);
  };
  const capture = async name => {
    await sleep(250);
    fs.writeFileSync(path.join(dir, name + '.png'), (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG());
  };
  const openList = async width => {
    if (width < 768) { await run("document.querySelector('[aria-label=\"Open agent list\"]').click()"); await sleep(200); }
  };
  const openCreate = async () => {
    await run("document.querySelector('[title=\"New agent with a terminal\"]').dispatchEvent(new FocusEvent('focusin', {bubbles:true}))");
    await sleep(200);
  };
  const create = async (label, expected) => {
    await openCreate();
    await run(`[...document.querySelectorAll('.create-row')].find(button => button.textContent.includes(${JSON.stringify(label)})).click()`);
    await check(`${label} stays in Agents`, "integration.state().view === 'command'");
    await check(`${label} payload`, expected);
  };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    // Mapped outside every monitor and non-focusable; no user's app/profile is used.
    win.showInactive();
    await sleep(800);
    for (const theme of ['light', 'dark']) for (const width of [1200, 400]) {
      win.setContentSize(width, 900);
      await run('integration.reset()');
      await sleep(500);
      await run(`(() => {
        document.documentElement.dataset.theme = '${theme}';
        const completed = integration.records()[0];
        Object.assign(completed, { archivedAt: Date.now(), id: 'completed', title: 'Completed conversation' });
        integration.records().push({ ...completed, id: 'active', title: 'Active conversation', archivedAt: undefined });
        integration.records().push({ ...completed, id: 'project-completed', title: 'Completed project conversation', workspaceId: 'finished-project' });
        const state = integration.state();
        state.settings.workspaces.push({ id: 'finished-project', name: 'Finished project', path: '/synthetic/finished' });
        state.refreshSessions();
      })()`);
      await sleep(500);
      if (!base) {
        await openList(width);
        await run("document.querySelectorAll('[data-completed-toggle]').forEach(button => button.click())");
        await check('completed-only project remains reachable', "!!document.querySelector('[data-completed-row=project-completed]')");
      }
      await capture(`agents-${theme}-${width}`);
      if (!base) {
        await run("document.querySelector('[data-completed-row=completed]').click()");
        await check('completed opens read-only reader', "document.body.textContent.includes('Back to active agents') && !document.querySelector('[data-wall-composer]')");
        await capture(`completed-${theme}-${width}`);
        await run("[...document.querySelectorAll('button')].find(button => button.textContent === 'Back to active agents').click()");
        await openList(width);
        await run("[...document.querySelectorAll('div[role=button]')].find(card => card.getAttribute('title')?.includes('Active conversation')).click()");
        // Outside Focus a card keeps the layout and marks its window active.
        await check('active card selects its window in Agents', "integration.state().view === 'command' && document.querySelector('[data-wall-layout]')?.dataset.wallLayout === 'grid' && document.querySelector('[data-wall-selected]')?.dataset.gridCell === 'chat:active'");
        await openList(width);
        if (width >= 768) {
          await run("document.querySelector('[aria-label=\"Resize the agent list\"]').dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowRight', bubbles:true}))");
          await check('keyboard resize persists', "localStorage.getItem('nekko.wsSidebarWidth') === '272'");
        }
        await create('Agent', "integration.calls.some(call => call.method === 'create')");
        await create('Create or Edit Photos and Videos', "integration.calls.some(call => call.method === 'options' && call.options.chatType === 'image')");
        await create('Terminal', "integration.calls.some(call => call.method === 'terminal') && integration.state().terminals.length === 1");
        await run("[...document.querySelectorAll('div[role=button]')].find(card => card.getAttribute('title')?.includes('Active conversation')).dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, clientX:60, clientY:100}))");
        await check('existing card context actions retained', "document.body.textContent.includes('Mark as completed') && document.body.textContent.includes('Change model')");
        await run("document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))");
        // Synthetic DOM drag validates the host payload; real pointer evidence is separate.
        await run(`(() => {
          const card = [...document.querySelectorAll('div[role=button]')].find(card => card.getAttribute('title')?.includes('Active conversation'));
          card.parentElement.dispatchEvent(new DragEvent('dragstart', { bubbles:true, dataTransfer:new DataTransfer() }));
        })()`);
        await sleep(100);
        await run(`(() => {
          const group = [...document.querySelectorAll('[data-sidebar-group]')].find(button => button.textContent.includes('Finished project'));
          group.closest('.mb-1').dispatchEvent(new DragEvent('drop', { bubbles:true, dataTransfer:new DataTransfer() }));
        })()`);
        await check('drag refiles owning chat', "integration.calls.some(call => call.method === 'workspace' && call.id === 'active' && call.workspaceId === 'finished-project')");
        await check('drag persists chat order', "integration.calls.some(call => call.method === 'options' && call.id === 'active' && call.options.order === 0)");
        await run("[...document.querySelectorAll('div[role=button]')].find(card => card.getAttribute('title')?.includes('Active conversation')).dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, clientX:60, clientY:100}))");
        await sleep(100);
        await run("[...document.querySelectorAll('button')].find(button => button.textContent === 'Mark as completed').click()");
        await sleep(1000);
        await check('complete targets owning chat', "integration.calls.some(call => call.method === 'abort' && call.id === 'active') && integration.calls.some(call => call.method === 'options' && call.id === 'active' && call.options.archivedAt)");
        await check('complete saved summary stays discoverable', "integration.state().sessions.some(session => session.id === 'active' && session.archivedAt)");
      }
      // Completed rows' right-click menu: Restore chat / Delete forever.
      await openList(width);
      await run("document.querySelectorAll('[data-completed-toggle][aria-expanded=false]').forEach(button => button.click())");
      await sleep(200);
      const rightClick = id => run(`(() => { const row = document.querySelector('[data-completed-row=${id}]'); const r = row.getBoundingClientRect(); row.dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, cancelable:true, clientX:r.left+40, clientY:r.top+r.height/2})); })()`);
      await rightClick('project-completed');
      await capture(`completed-menu-${theme}-${width}`);
      if (!base) {
        await check('completed menu offers restore and delete', "(() => { const items = [...document.querySelectorAll('[role=menu] [role=menuitem]')].map(b => b.textContent.trim()); return items.length === 2 && items[0] === 'Restore chat' && items[1] === 'Delete forever'; })()");
        await run("[...document.querySelectorAll('[role=menuitem]')].find(b => b.textContent.includes('Restore chat')).click()");
        await check('menu restore un-completes the chat', "integration.calls.some(call => call.method === 'options' && call.id === 'project-completed' && call.options.archivedAt === null) && integration.state().sessions.some(s => s.id === 'project-completed' && !s.archivedAt) && !document.querySelector('[role=menu]')");
        await openList(width);
        await run("document.querySelector('[data-completed-row=completed]').click()");
        await check('reader open before delete', "document.body.textContent.includes('Back to active agents')");
        await openList(width);
        await run("document.querySelectorAll('[data-completed-toggle][aria-expanded=false]').forEach(button => button.click())");
        await sleep(200);
        await rightClick('completed');
        await run("[...document.querySelectorAll('[role=menuitem]')].find(b => b.textContent.includes('Delete forever')).click()");
        await check('menu delete asks first', "document.body.textContent.includes('Confirm deletion') && !integration.calls.some(call => call.method === 'cleanup' && call.id === 'completed')");
        await capture(`completed-delete-confirm-${theme}-${width}`);
        await run("[...document.querySelectorAll('button')].find(b => b.textContent === 'Delete').click()");
        await check('menu delete removes the chat and closes its reader', "integration.calls.some(call => call.method === 'cleanup' && call.id === 'completed') && !integration.state().sessions.some(s => s.id === 'completed') && !document.body.textContent.includes('Back to active agents')");
      }
      await run("integration.route('workspace')");
      await sleep(400);
      await capture(`chat-${theme}-${width}`);
      if (!base) await check('Chat no longer owns sidebar', "!document.querySelector('[data-sidebar-group]')");
    }
    if (report.errors.length || win.isFocused()) throw Error('Fixture focus invariant failed');
    report.success = true;
  } catch (error) {
    report.errors.push(String(error)); report.success = false;
  } finally {
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ dir, ...report }, null, 2));
    win.destroy(); app.exit(report.success ? 0 : 1);
  }
});
