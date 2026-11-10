// One-click connector setup (#2492): the Connectors page on the real App
// against the synthetic bridge. Rows start as a single Connect button; the
// steps open one at a time; a signed-in GitHub CLI connects GitHub in one
// click; a recognised pasted key connects without another click.
// Hidden, off-screen, non-focusable, blocked network, isolated profile.
// Launch: NEKKO_LAYOUT_SANDBOX=connector-setup-sandbox.cjs node layout-evidence-integration.cjs
// NEKKO_CONNECTOR_BASELINE=1 takes only the overview shots (for a "before" run).
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
  const row = (kind) => `document.querySelector('[data-connector=${kind}]')`;
  const click = (kind, label) => run(`[...${row(kind)}.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)}).click()`);
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 60 && !(await run("!!window.layoutFixture && !!document.querySelector('.rail')")); i++) await sleep(200);
    await sleep(800);
    // A stateful stand-in for the daemon's connector channels.
    await run(`(() => {
      const b = layoutFixture.bridge;
      window.saved = []; window.opened = []; window.calls = [];
      const list = async () => window.saved.map(c => ({ ...c }));
      b.listConnectors = list;
      b.getMessagingStatus = async () => ({ telegram: {}, discord: {}, slack: {} });
      b.detectConnectors = async () => ({ github: { source: 'gh', account: 'octocat' } });
      b.importConnectorCli = async (kind) => { window.calls.push('importCli:' + kind); window.saved.push({ kind, connected: true }); return list(); };
      b.connectConnector = async (kind, token, settings) => { window.calls.push('connect:' + kind + ':' + token); window.saved.push({ kind, connected: true }); return list(); };
      b.disconnectConnector = async (kind) => { window.saved = window.saved.filter(c => c.kind !== kind); return list(); };
      b.fetchConnector = async (kind) => [{ id: '1', title: kind === 'github' ? 'nekko-labs/nekko-agent' : 'First item', subtitle: 'updated today' }];
      b.openPath = async (url) => { window.opened.push(url); };
    })()`);
    await run(`layoutFixture.store.getState().setView('connectors')`);
    await sleep(1200);
    await shot('overview');
    win.setContentSize(390, 844); await sleep(400); await shot('overview-narrow');
    win.setContentSize(1280, 900); await sleep(400);
    if (baseline) return;

    await check('no key field until a setup starts', `!document.querySelector('[data-connector] input')`);
    await check('GitHub offers the CLI sign-in', `${row('github')}.textContent.includes('Ready: your GitHub CLI sign-in as @octocat')`);

    // GitLab: Connect opens step one only; Open fills in the token page and reveals step two.
    await click('gitlab', 'Connect'); await sleep(350);
    await check('step one shows, the key field does not', `${row('gitlab')}.textContent.includes('Create a token on GitLab') && !${row('gitlab')}.querySelector('input[type=password]')`);
    await shot('gitlab-step-one');
    await click('gitlab', 'Open'); await sleep(350);
    await check('opens the prefilled GitLab token page', `window.opened.at(-1) === 'https://gitlab.com/-/user_settings/personal_access_tokens?name=Nekko%20Agent&scopes=api'`);
    await check('step two asks for the key', `!!${row('gitlab')}.querySelector('input[type=password]') && ${row('gitlab')}.textContent.includes('Paste it here')`);
    await shot('gitlab-step-two');

    // Pasting a recognised key connects without pressing Connect.
    await run(`(() => { const i = ${row('gitlab')}.querySelector('input[type=password]'); i.focus(); const dt = new DataTransfer(); dt.setData('text/plain', 'glpat-abcdefghijklmnopqrstuvwx'); i.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
    await sleep(500);
    await check('a pasted GitLab token connects at once', `window.calls.includes('connect:gitlab:glpat-abcdefghijklmnopqrstuvwx') && ${row('gitlab')}.dataset.stage === 'connected'`);

    // GitHub: one click with the CLI sign-in, no token typed or shown.
    await click('github', 'Connect'); await sleep(500);
    await check('GitHub connects from the CLI sign-in in one click', `window.calls.includes('importCli:github') && ${row('github')}.dataset.stage === 'connected'`);
    await check('no GitHub token was handled by the UI', `!window.calls.some(c => c.startsWith('connect:github'))`);
    await shot('github-connected');

    // GitHub's own token path, after disconnecting: the prefilled classic-token page.
    await click('github', 'Disconnect'); await sleep(300);
    await click('github', 'Use a token'); await sleep(350);
    await click('github', 'Open'); await sleep(350);
    await check('opens the prefilled GitHub token page', `window.opened.at(-1) === 'https://github.com/settings/tokens/new?description=Nekko%20Agent&scopes=repo,read:org'`);
    await shot('github-token-steps');

    // Jira needs fields with the key, so its step two holds all three.
    await click('jira', 'Connect'); await sleep(300);
    await click('jira', 'I already have one'); await sleep(350);
    await check('Jira step two holds site, email and token', `${row('jira')}.querySelectorAll('input').length === 3`);
    win.setContentSize(390, 844); await sleep(400);
    await shot('steps-narrow');
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
