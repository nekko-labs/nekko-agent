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
  // JSON.stringify leaves <, >, / and U+2028/2029 raw; escape them before splicing into evaluated code.
  const js = (v) => JSON.stringify(v).replace(/[<>/  ]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
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
  const click = (label) => run(`(() => { const b = [...${gh}.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || b.textContent.trim()) === ${js(label)} || b.textContent.trim().startsWith(${js(label)})); if (!b) throw Error('no button ' + ${js(label)}); b.click(); })()`);
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 60 && !(await run("!!window.layoutFixture && !!document.querySelector('.rail')")); i++) await sleep(200);
    await sleep(800);
    await run(`(() => {
      const b = layoutFixture.bridge;
      window.saved = [{ kind: 'github', connected: true, settings: {} }, { kind: 'linear', connected: true }]; window.calls = [];
      const list = async () => window.saved.map(c => ({ ...c, settings: { ...c.settings } }));
      const names = ['nekko-labs/nekko-agent', 'nekko-labs/floop', 'nekko-labs/hypergate', 'ermish/dotfiles', 'ermish/notes', 'acme-corp/site', 'acme-corp/api'];
      const repos = names.map((fullName, i) => ({ provider: 'github', id: String(i), fullName, cloneUrl: 'https://github.com/' + fullName + '.git', webUrl: 'https://github.com/' + fullName, defaultBranch: 'main', private: fullName.startsWith('ermish/notes') || fullName.startsWith('acme'), description: '', updatedAt: '' }));
      b.listConnectors = list;
      b.getMessagingStatus = async () => ({ telegram: {}, discord: {}, slack: {} });
      b.detectConnectors = async () => ({});
      b.fetchConnector = async (kind) => kind === 'linear'
        ? [{ id: 'l1', title: 'Fix the login redirect', subtitle: 'NEK-12 · In Progress' }, { id: 'l2', title: 'Group repositories by org', subtitle: 'NEK-14 · Todo' }]
        : repos.slice(0, 3).map(r => ({ id: r.id, title: r.fullName, subtitle: 'repo' }));
      b.connectorRepos = async () => ({ repos, providers: [{ kind: 'github' }] });
      b.excludeConnectorRepos = async (kind, choice) => { window.calls.push(JSON.stringify(choice)); window.saved = window.saved.map(c => c.kind === kind ? { ...c, settings: { ...c.settings, ...choice } } : c); return list(); };
    })()`);
    await run(`layoutFixture.store.getState().setView('connectors')`);
    await sleep(1200);
    // The sample fetch the row shows after connecting. GitHub's own Fetch
    // sample exists only before the change; Linear's on both sides.
    const clickIn = (kind, label) => run(`[...document.querySelector('[data-connector=${kind}]').querySelectorAll('button')].find(b => b.textContent.trim() === ${js(label)}).click()`);
    if (baseline) await click('Fetch sample');
    await clickIn('linear', 'Fetch sample'); await sleep(400);
    await shot(baseline ? 'repos-before-v2' : 'repos-closed-v2');
    if (baseline) return;

    await check('GitHub has no Fetch sample beside its repository list', `![...${gh}.querySelectorAll('button')].some(b => b.textContent.trim() === 'Fetch sample')`);
    await check('the sample starts closed with a count', `document.querySelector('[data-connector=linear] [data-connector-sample] button[aria-expanded=false]').textContent.includes('Sample2') && !document.querySelector('[data-connector=linear]').textContent.includes('Fix the login')`);
    await clickIn('linear', 'Sample2'); await sleep(400);
    await check('the sample opens', `document.querySelector('[data-connector=linear]').textContent.includes('Fix the login redirect')`);

    await check('Repositories starts closed with a count', `${gh}.querySelector('[data-connector-repos] button[aria-expanded=false]').textContent.includes('Repositories7')`);
    await click('Repositories'); await sleep(400);
    await check('three owner groups, A to Z', `[...${gh}.querySelectorAll('[data-repo-group]')].map(g => g.dataset.repoGroup).join() === 'acme-corp,ermish,nekko-labs'`);
    await click('nekko-labs'); await sleep(350);
    await check('a group opens to its repositories', `${gh}.textContent.includes('hypergate')`);
    await check('no repository shows twice', `!${gh}.textContent.includes('nekko-labs/nekko-agent')`);
    await shot('repos-open-v2');

    const hover = await run(`(() => { const r = ${gh}.querySelector('[aria-label="Remove nekko-labs/hypergate"]').closest('[data-quiet-row]').getBoundingClientRect(); return { x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2) }; })()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: hover.x, y: hover.y }); await sleep(300);
    await check('a row shows Remove on hover', `getComputedStyle(${gh}.querySelector('[aria-label="Remove nekko-labs/hypergate"]')).opacity === '1'`);
    await shot('repos-hover-v2');
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 5, y: 5 });

    await click('Remove nekko-labs/floop'); await sleep(350);
    await click('Remove acme-corp'); await sleep(350);
    await check('saves the removed repository and org', `window.calls.at(-1) === JSON.stringify({ excludedRepos: ['nekko-labs/floop'], excludedOwners: ['acme-corp'] })`);
    await check('the stale sample list is cleared', `!${gh}.textContent.includes('nekko-labs/floop')`);
    await check('the count shows what is kept', `${gh}.querySelector('[data-connector-repos]').textContent.includes('4 of 7')`);
    await click('Removed'); await sleep(350);
    await check('removed items can be added back', `!!${gh}.querySelector('[aria-label="Add back acme-corp"]') && !!${gh}.querySelector('[aria-label="Add back nekko-labs/floop"]')`);
    await shot('repos-removed-v2');

    await click('Add back acme-corp'); await sleep(350);
    await check('adding an org back saves it', `window.calls.at(-1) === JSON.stringify({ excludedRepos: ['nekko-labs/floop'], excludedOwners: [] })`);
    win.setContentSize(390, 844); await sleep(400);
    await shot('repos-narrow-v2');
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
