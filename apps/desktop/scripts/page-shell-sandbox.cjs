// Settings, Skills, Connectors and Models against their references, Artifacts and Scheduled Tasks:
// the same shots and shell measurements of all six at 1440 and 600 wide, so a
// drift between the shells shows up as a number as well as a picture.
// Launch: NEKKO_LAYOUT_SANDBOX=page-shell-sandbox.cjs node layout-evidence-integration.cjs
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
fs.cpSync(path.join(process.env.NEKKO_TEST_SOURCE || path.resolve(__dirname, '../../..'), 'apps/desktop/src/renderer/public/providers'), path.join(out, 'providers'), { recursive: true });
const js = (value) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { captures: [], metrics: {}, checks: [], errors: [] };
const check = (name, passed) => report.checks.push({ name, passed: !!passed });
const VIEWS = ['artifacts', 'workflows', 'settings', 'skills', 'connectors', 'models'];
const measure = `(() => {
  const main = document.querySelector('main');
  const cs = (el) => el && getComputedStyle(el);
  const rail = document.querySelector('main aside');
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const shell = main.firstElementChild;
  return {
    mainPadding: cs(main).padding,
    mainBg: cs(main).backgroundColor,
    shellBg: cs(shell).backgroundColor,
    shellRadius: cs(shell).borderRadius,
    main: box(main),
    rail: box(rail),
    railBorder: rail ? cs(rail).borderRightWidth : null,
    overflow: document.documentElement.scrollWidth > innerWidth,
  };
})()`;
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const minX = Math.min(...screen.getAllDisplays().map((d) => d.bounds.x));
  const minY = Math.min(...screen.getAllDisplays().map((d) => d.bounds.y));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: minX - 4000, y: minY - 4000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('show', () => report.errors.push('Window became visible'));
  win.on('focus', () => report.errors.push('Window took focus'));
  win.webContents.on('console-message', (e) => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  const run = (s) => win.webContents.executeJavaScript(s, true);
  const shot = async (name) => {
    await win.capturePage(undefined, { stayHidden: true });
    await sleep(200);
    const file = path.join(out, name + '.png');
    fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG());
    report.captures.push(file);
  };
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 60 && !(await run("!!document.querySelector('.rail') && !!document.querySelector('[data-command-wall]')")); i++) await sleep(200);
    await run(`(async () => {
      const b = layoutFixture.bridge;
      const wf = (id, name, category) => ({ id, name, category, description: 'Fixture task', enabled: true, steps: [], triggers: [{ kind: 'manual' }], createdAt: 1, updatedAt: 1 });
      const snapshot = { workflows: [wf('a', 'Nightly review', 'Code review'), wf('b', 'Tidy branches', 'Maintenance')], runs: [] };
      b.listWorkflows = async () => snapshot;
      b.onWorkflowsUpdated = () => () => {};
      b.getRemoteStatus = async () => ({ enabled: false, online: false, devices: [], connected: [] });
      b.listConnectors = async () => [];
      b.getMessagingStatus = async () => ({ telegram: {}, discord: {}, slack: {} });
      b.telemetryStatus = async () => ({ configured: false });
      b.oauthStatus = async () => ({ connected: false });
      b.listModelsStatus = async () => ({ models: [] });
      b.testProvider = async () => ({ ok: true });
      b.listProviderModels = async () => [];
      await b.updateSettings({ guardrails: [], hooks: [] });
    })()`);
    for (const width of [1440, 600]) {
      win.setContentSize(width, 900);
      for (const view of VIEWS) {
        await run(`layoutFixture.store.getState().setView(${js(view)})`);
        await sleep(900);
        await shot(`${view}-${width}`);
        report.metrics[`${view}-${width}`] = await run(measure);
      }
    }
    win.setContentSize(1440, 900);
    await run(`layoutFixture.store.getState().setView('settings')`);
    await sleep(900);
    // The rail sits outside the scroller, so all of this depends on the split.
    const railTop = `document.querySelector('.settings-nav-item').getBoundingClientRect().top`;
    const before = await run(railTop);
    await run(`(() => { const s = document.querySelector('.settings-content'); s.scrollTop = s.scrollHeight; })()`);
    await sleep(300);
    check('the rail stays put while the page scrolls', Math.abs((await run(railTop)) - before) < 1);
    check('the scroll spy follows the page to System', await run(`document.querySelector('.settings-nav-item[aria-current]')?.textContent.includes('System')`));
    await run(`document.querySelector('.settings-content').scrollTop = 0`);
    await sleep(300);
    await run(`document.querySelector('[aria-label="Search settings"]').click()`);
    await sleep(200);
    await run(`(() => { const i = document.querySelector('.settings-search-input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'Backup'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(2200);
    check('search scrolls the page to a match', (await run(`document.querySelector('.settings-content').scrollTop`)) > 0);
    await run(`document.querySelector('[aria-label="Close search"]').click()`);
    await run(`layoutFixture.store.getState().setView('models')`);
    await sleep(900);
    check('Models has no side menu', await run(`!document.querySelector('main nav, main aside')`));
    report.metrics.headings = await run(`[...document.querySelectorAll('.models-section')].map((s) => { const size = (el) => parseFloat(getComputedStyle(el).fontSize); const head = s.querySelector('.models-section-heading'); return { head: size(head), icon: !!head.querySelector('svg'), nested: Math.max(0, ...[...s.querySelectorAll('h1, h2, h3, h4')].filter((h) => h !== head).map(size)) }; })`);
    check('each section heading has its icon and is the biggest in its section', report.metrics.headings.length === 2 && report.metrics.headings.every((h) => h.icon && h.head > h.nested));
    report.metrics.nestedTitle = await run(`(() => { const h = document.createElement('h1'); h.className = 'text-2xl'; document.querySelector('.models-section').append(h); const size = parseFloat(getComputedStyle(h).fontSize); h.remove(); return size; })()`);
    check('a 24px title nested in a section steps below its heading', report.metrics.nestedTitle < report.metrics.headings[0].head);
    await run(`layoutFixture.store.getState().setView('modelserver')`);
    await sleep(300);
    await run(`layoutFixture.store.getState().setView('models')`);
    await sleep(1200);
    report.metrics.cloudOffset = await run(`Math.round(document.querySelector('.models-section-cloud').getBoundingClientRect().top - document.querySelector('.models-workspace').getBoundingClientRect().top)`);
    check('the models destination brings the Cloud section to the top', report.metrics.cloudOffset <= 24);
    await run(`layoutFixture.store.getState().setView('settings')`);
    await sleep(900);
    report.metrics.railFont = await run(`[...new Set([...document.querySelectorAll('.settings-nav-item')].map((b) => getComputedStyle(b).fontSize))]`);
    check('every Settings rail item is 16px', report.metrics.railFont.length === 1 && report.metrics.railFont[0] === '16px');
    for (const view of ['skills', 'connectors']) {
      await run(`layoutFixture.store.getState().setView(${js(view)})`);
      await sleep(900);
      report.metrics[`${view}Edges`] = await run(`(() => { const x = (el) => Math.round(el.getBoundingClientRect().x + parseFloat(getComputedStyle(el).paddingLeft)); return { back: x(document.querySelector('.settings-back-bar .btn')), page: x(document.querySelector('.settings-destination-content .max-w-5xl')) }; })()`);
      check(`the Back button lines up with the ${view} page`, Math.abs(report.metrics[`${view}Edges`].back - report.metrics[`${view}Edges`].page) <= 1);
    }
    report.hidden = !win.isVisible();
  } catch (e) { report.errors.push(String((e && e.stack) || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ checks: report.checks, cloudOffset: report.metrics.cloudOffset, headings: report.metrics.headings, railFont: report.metrics.railFont, nestedTitle: report.metrics.nestedTitle, errors: report.errors, hidden: report.hidden }, null, 1));
  app.exit(report.captures.length === VIEWS.length * 2 && report.checks.every((c) => c.passed) && !report.errors.length ? 0 : 1);
});
