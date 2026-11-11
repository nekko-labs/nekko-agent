// Choosing GitHub repositories (#2562): the Connectors page on the real App
// against the synthetic bridge, GitHub connected with repositories under
// three owners. The Repositories disclosure starts closed with a count; it
// opens to owner groups; Remove and Remove org move items to Removed; Add
// back returns them; every change saves through excludeConnectorRepos.
// Hidden, off-screen, non-focusable, blocked network, isolated profile.
// Launch: NEKKO_LAYOUT_SANDBOX=connector-repos-sandbox.cjs node layout-evidence-integration.cjs
// NEKKO_CONNECTOR_BASELINE=1 takes only the connected-row shot (for a "before" run).
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.disableHardwareAcceleration();
app.setPath('userData', path.join(out, 'profile'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const baseline = process.env.NEKKO_CONNECTOR_BASELINE === '1';
const report = { captures: [], checks: [], errors: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const minX = Math.min(...screen.getAllDisplays().map((d) => d.bounds.x));
  const minY = Math.min(...screen.getAllDisplays().map((d) => d.bounds.y));
  const win = new BrowserWindow({ width: 1280, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: minX - 4000, y: minY - 4000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('show', () => report.errors.push('Window became visible'));
  win.on('focus', () => report.errors.push('Window took focus'));
  win.webContents.on('console-message', (e) => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  const run = (s) => win.webContents.executeJavaScript(s, true);
  const shot = async (name) => {
    await run('document.getAnimations().forEach(a => { try { a.finish(); } catch {} })');
    await win.capturePage(undefined, { stayHidden: true });
    await sleep(250);
    const file = path.join(out, name + '.png');
    fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true })).toPNG());
    report.captures.push(file);
  };
  const check = async (name, code) => { if (!(await run(code))) throw Error('check failed: ' + name); report.checks.push(name); };
  const gh = `document.querySelector('[data-connector=github]')`;
  const click = (label) => run(`(() => { const b = [...${gh}.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || b.textContent.trim()) === ${JSON.stringify(label)} || b.textContent.trim().startsWith(${JSON.stringify(label)})); if (!b) throw Error('no button ' + ${JSON.stringify(label)}); b.click(); })()`);
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 60 && !(await run("!!window.layoutFixture && !!document.querySelector('.rail')")); i++) await sleep(200);
    await sleep(800);
    await run(`(() => {
      const b = layoutFixture.bridge;
      window.saved = [{ kind: 'github', connected: true, settings: {} }]; window.calls = [];
      const list = async () => window.saved.map(c => ({ ...c, settings: { ...c.settings } }));
      const names = ['nekko-labs/nekko-agent', 'nekko-labs/floop', 'nekko-labs/hypergate', 'ermish/dotfiles', 'ermish/notes', 'acme-corp/site', 'acme-corp/api'];
      const repos = names.map((fullName, i) => ({ provider: 'github', id: String(i), fullName, cloneUrl: 'https://github.com/' + fullName + '.git', webUrl: 'https://github.com/' + fullName, defaultBranch: 'main', private: fullName.startsWith('ermish/notes') || fullName.startsWith('acme'), description: '', updatedAt: '' }));
      b.listConnectors = list;
      b.getMessagingStatus = async () => ({ telegram: {}, discord: {}, slack: {} });
      b.detectConnectors = async () => ({});
      b.fetchConnector = async () => repos.slice(0, 3).map(r => ({ id: r.id, title: r.fullName, subtitle: 'repo' }));
      b.connectorRepos = async () => ({ repos, providers: [{ kind: 'github' }] });
      b.excludeConnectorRepos = async (kind, choice) => { window.calls.push(JSON.stringify(choice)); window.saved = window.saved.map(c => c.kind === kind ? { ...c, settings: { ...c.settings, ...choice } } : c); return list(); };
    })()`);
    await run(`layoutFixture.store.getState().setView('connectors')`);
    await sleep(1200);
    // The sample fetch the row shows after connecting, on both sides of the change.
    await click('Fetch sample'); await sleep(400);
    await shot('github-connected');
    if (baseline) return;

    await check('Repositories starts closed with a count', `${gh}.querySelector('[data-connector-repos] button[aria-expanded=false]').textContent.includes('Repositories7')`);
    await click('Repositories'); await sleep(400);
    await check('three owner groups, A to Z', `[...${gh}.querySelectorAll('[data-repo-group]')].map(g => g.dataset.repoGroup).join() === 'acme-corp,ermish,nekko-labs'`);
    await click('nekko-labs'); await sleep(350);
    await check('a group opens to its repositories', `${gh}.textContent.includes('hypergate')`);
    await shot('repos-open');

    const hover = await run(`(() => { const r = ${gh}.querySelector('[aria-label="Remove nekko-labs/hypergate"]').closest('[data-quiet-row]').getBoundingClientRect(); return { x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2) }; })()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: hover.x, y: hover.y }); await sleep(300);
    await check('a row shows Remove on hover', `getComputedStyle(${gh}.querySelector('[aria-label="Remove nekko-labs/hypergate"]')).opacity === '1'`);
    await shot('repos-hover');
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 5, y: 5 });

    await click('Remove nekko-labs/floop'); await sleep(350);
    await click('Remove acme-corp'); await sleep(350);
    await check('saves the removed repository and org', `window.calls.at(-1) === JSON.stringify({ excludedRepos: ['nekko-labs/floop'], excludedOwners: ['acme-corp'] })`);
    await check('the stale sample list is cleared', `!${gh}.textContent.includes('nekko-labs/floop')`);
    await check('the count shows what is kept', `${gh}.querySelector('[data-connector-repos]').textContent.includes('4 of 7')`);
    await click('Removed'); await sleep(350);
    await check('removed items can be added back', `!!${gh}.querySelector('[aria-label="Add back acme-corp"]') && !!${gh}.querySelector('[aria-label="Add back nekko-labs/floop"]')`);
    await shot('repos-removed');

    await click('Add back acme-corp'); await sleep(350);
    await check('adding an org back saves it', `window.calls.at(-1) === JSON.stringify({ excludedRepos: ['nekko-labs/floop'], excludedOwners: [] })`);
    win.setContentSize(390, 844); await sleep(400);
    await shot('repos-narrow');
    await check('narrow width does not overflow', 'document.documentElement.scrollWidth <= innerWidth');
  } catch (e) {
    report.errors.push(String((e && e.stack) || e));
  } finally {
    report.hidden = !win.isVisible();
    report.windowBounds = win.getBounds();
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ checks: report.checks, errors: report.errors, hidden: report.hidden, bounds: report.windowBounds }, null, 1));
    app.exit(report.errors.length ? 1 : 0);
  }
});
