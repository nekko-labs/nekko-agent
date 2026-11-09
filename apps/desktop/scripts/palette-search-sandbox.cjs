// Ctrl+K "search everything" evidence; never connects to the user's host or profile.
// Launch: NEKKO_LAYOUT_SANDBOX=palette-search-sandbox.cjs NEKKO_TEST_LABEL=palette-after node layout-evidence-integration.cjs
// (NEKKO_TEST_SOURCE=<a main checkout> with NEKKO_TEST_LABEL=palette-before for the "before" shots).
// Seeds synthetic chats with messages and an artifact, opens the palette, types
// through real renderer key events in a hidden, non-focusable, off-screen
// window, captures each state and reads the rows back.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
app.setPath('sessionData', path.join(out, 'profile'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SEED = `(async () => {
  const f = window.layoutFixture; const now = Date.now(); const H = 3600e3;
  const msg = (id, role, content, ago) => ({ id, role, content, createdAt: now - ago });
  const chat = (id, title, ago, workspaceId, messages) => ({ id, title, createdAt: now - ago - H, updatedAt: now - ago, providerId: 'fixture', modelId: 'gpt-fixture', mode: 'agent', chatType: 'multimodal', workspaceId, messages, attachments: [], queuedPrompts: [] });
  f.records.splice(0, f.records.length,
    chat('t1', 'Fix the theme picker flicker', 2 * H, 'w1', [
      msg('t1u', 'user', 'The theme picker flickers when I switch presets', 3 * H),
      msg('t1a', 'assistant', 'Fixed it, the new tokens are in [Theme tokens](file:///C:/work/nekko/reports/theme-tokens.md).', 2 * H)]),
    // Matches only in a middle message, so they are message results, not chat results.
    chat('r1', 'Release notes for 0.9', 26 * H, 'w1', [
      msg('r1u', 'user', 'Draft the release notes', 28 * H),
      msg('r1m', 'assistant', 'Highlights: a new dark theme switch, faster startup, and the settings search.', 27 * H),
      msg('r1u2', 'user', 'Shorter please', 26.5 * H),
      msg('r1a', 'assistant', 'Done, three bullets now.', 26 * H)]),
    chat('q1', 'Quarterly budget review', 50 * H, undefined, [
      msg('q1u', 'user', 'Summarize spend by team', 52 * H),
      msg('q1m', 'assistant', 'Design spent most on the new theme work; config changes saved the infra team 12%.', 51 * H),
      msg('q1u2', 'user', 'Thanks', 50.5 * H),
      msg('q1a', 'assistant', 'Anytime.', 50 * H)]),
    chat('p1', 'Where are my preferences stored?', 80 * H, undefined, [
      msg('p1u', 'user', 'Where does the app keep its config file?', 81 * H),
      msg('p1a', 'assistant', 'Settings live in settings.json under the data folder.', 80 * H)]),
  );
  f.records.forEach(f.putCachedSession);
  f.settings.workspaces = [{ id: 'w1', name: 'nekko-agent', path: 'C:/work/nekko' }];
  const sessions = await f.bridge.listSessionSummaries();
  f.store.setState({ sessions, settings: { ...f.settings } });
  return sessions.length;
})()`;

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((request, done) => done({ cancel: !/^(file:|data:|blob:)/.test(request.url) }));
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, done) => done(false));
  const left = Math.min(...screen.getAllDisplays().map((d) => d.bounds.x));
  const win = new BrowserWindow({
    width: 1100, height: 760, useContentSize: true, show: false, focusable: false, skipTaskbar: true,
    x: left - 3000, y: -2000, title: 'Synthetic palette search verification',
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  const report = { checks: [], errors: [], rows: {} };
  win.webContents.on('console-message', (e) => { if (e.level === 'error') report.errors.push('console: ' + e.message); });
  const run = (source) => win.webContents.executeJavaScript(source, true);
  const check = (name, ok) => report.checks.push({ name, passed: !!ok });
  const capture = async (name) => { win.webContents.invalidate(); await sleep(500); win.webContents.invalidate(); await sleep(300); fs.writeFileSync(path.join(out, name + '.png'), (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG()); };
  const key = async (keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (keyCode.length === 1) win.webContents.sendInputEvent({ type: 'char', keyCode, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await sleep(40);
  };
  const type = async (text) => { for (const ch of text) await key(ch === ' ' ? ' ' : ch); };
  const clear = async () => { await key('A', ['control']); await key('Backspace'); await sleep(150); };
  const open = async () => { await run(`layoutFixture.store.getState().setPaletteOpen(false)`); await sleep(100); await run(`layoutFixture.store.getState().setPaletteOpen(true)`); await sleep(800); };
  // Each row as text: its kind, its breadcrumb line, its second line, and the words marked in it.
  const rows = () => run(`[...document.querySelectorAll('[role="listbox"] [role="option"]')].map(r => ({
    kind: r.dataset.paletteKind || null,
    crumbs: (r.querySelector('[data-palette-crumbs]') || r).textContent.trim(),
    context: r.querySelector('[data-palette-context]')?.textContent.trim() || '',
    marked: [...r.querySelectorAll('mark')].map(m => m.textContent),
  }))`);
  try {
    await win.loadFile(path.join(out, 'index.html'));
    await sleep(2000);
    report.seeded = await run(SEED);
    // The first hidden capture can return a stale frame; take one to throw away.
    await capture('warmup'); fs.rmSync(path.join(out, 'warmup.png'), { force: true });
    await sleep(300);
    for (const [name, q] of [['prefs', 'prefs'], ['theme', 'theme'], ['empty', '']]) {
      await open();
      await type(q); await sleep(900);
      report.rows[name] = await rows();
      await capture(`palette-${name}`);
    }
    // The Messages filter: Tab steps All -> Commands -> Settings -> Chats -> Messages.
    await open(); await type('theme'); await sleep(900);
    for (let i = 0; i < 4; i++) await key('Tab');
    await sleep(500);
    report.rows['theme-messages'] = await rows();
    await capture('palette-theme-messages');

    const filters = await run(`!!document.querySelector('[data-palette-filters]')`);
    if (filters) {
      const prefs = report.rows.prefs;
      check('prefs: Go to Settings ranks first', /Go to Settings/.test(prefs[0]?.crumbs ?? ''));
      check('prefs: the synonym that matched is marked', prefs[0]?.marked.includes('Settings'));
      check('prefs: a chat titled "preferences" is found too', prefs.some((r) => r.kind === 'chat' && /preferences/.test(r.crumbs)));
      const theme = report.rows.theme;
      const firstMessage = theme.findIndex((r) => r.kind === 'message');
      check('theme: messages come after every other kind', firstMessage > 0 && theme.slice(firstMessage).every((r) => r.kind === 'message'));
      check('theme: chat breadcrumb names its project', theme.some((r) => r.kind === 'chat' && /Chats\s*›\s*nekko-agent\s*›\s*Fix the theme picker/.test(r.crumbs)));
      check('theme: artifact found with its chat in the breadcrumb', theme.some((r) => r.kind === 'artifact' && /Artifacts\s*›\s*Fix the theme picker flicker\s*›\s*Theme tokens/.test(r.crumbs)));
      check('theme: message rows read Messages › chat with the matched text below', theme.some((r) => r.kind === 'message' && /^Messages\s*›/.test(r.crumbs) && /theme/i.test(r.context) && r.marked.some((m) => /theme/i.test(m))));
      check('theme: every row has two lines', theme.every((r) => r.context.length > 0));
      const messages = report.rows['theme-messages'];
      check('Messages filter shows only message rows', messages.length >= 2 && messages.every((r) => r.kind === 'message'));
    }
  } catch (e) {
    report.errors.push(String(e && e.stack || e));
  }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  const failed = report.checks.filter((c) => !c.passed);
  console.log(JSON.stringify({ checks: report.checks.length, failed, errors: report.errors.slice(0, 5) }, null, 2));
  win.destroy();
  app.exit(failed.length ? 1 : 0);
});
