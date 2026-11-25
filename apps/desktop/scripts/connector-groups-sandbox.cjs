// Connector groups and the Hypergate row (#3195): the Connectors page on the
// real App against the synthetic bridge. The page is grouped by kind; the
// Hypergate row's Connect checks this computer first and then says what it
// found (not installed, installed but stopped, connected after Start); the
// MCP servers group lists what Settings has, never arguments or tokens.
// Hidden, off-screen, non-focusable, blocked network, isolated profile.
// Launch: NEKKO_LAYOUT_SANDBOX=connector-groups-sandbox.cjs node layout-evidence-integration.cjs
// NEKKO_CONNECTOR_BASELINE=1 takes only the page shot (for a "before" run).
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
  const win = new BrowserWindow({ width: 1280, height: 2000, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: minX - 4000, y: minY - 4000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('show', () => report.errors.push('Window became visible'));
  win.on('focus', () => report.errors.push('Window took focus'));
  win.webContents.on('console-message', (e) => { if (e.level === 'error') report.errors.push(e.message.slice(0, 300)); });
  const run = (s) => win.webContents.executeJavaScript(s, true);
  const js = (v) => JSON.stringify(v).replace(/[<>/\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  /** Capture the window, or just `selector`'s box (padded) when given. */
  const shot = async (name, selector) => {
    await run('document.getAnimations().forEach(a => { try { a.finish(); } catch {} })');
    let rect;
    if (selector) {
      const r = await run(`(() => { const r = document.querySelector(${js(selector)}).getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`);
      rect = { x: Math.max(0, Math.floor(r.x - 16)), y: Math.max(0, Math.floor(r.y - 12)), width: Math.ceil(r.width + 32), height: Math.ceil(r.height + 24) };
    }
    await win.capturePage(rect, { stayHidden: true });
    await sleep(250);
    const file = path.join(out, name + '.png');
    fs.writeFileSync(file, (await win.capturePage(rect, { stayHidden: true })).toPNG());
    report.captures.push(file);
  };
  const check = async (name, code) => { if (!(await run(code))) throw Error('check failed: ' + name); report.checks.push(name); };
  const hg = `document.querySelector('[data-connector=hypergate]')`;
  const click = (label) => run(`(() => { const b = [...${hg}.querySelectorAll('button')].find(b => b.textContent.trim().startsWith(${js(label)})); if (!b) throw Error('no button ' + ${js(label)}); b.click(); })()`);
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 60 && !(await run("!!window.layoutFixture && !!document.querySelector('.rail')")); i++) await sleep(200);
    await sleep(800);
    await run(`(() => {
      const f = layoutFixture, b = f.bridge;
      f.settings.mcpServers = [
        { id: 'fs', name: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'], enabled: true },
        { id: 'web', name: 'search', command: '', args: [], url: 'https://mcp.example.com/mcp', token: 'secret-token', enabled: false },
      ];
      b.listConnectors = async () => [{ kind: 'github', connected: true, settings: {} }, { kind: 'linear', connected: true }];
      b.getMessagingStatus = async () => ({ telegram: {}, discord: {}, slack: {} });
      b.detectConnectors = async () => ({});
      b.connectorRepos = async () => ({ repos: [], providers: [{ kind: 'github' }] });
      b.detectHypergate = async () => null;
      window.calls = [];
      window.hg = { installed: false };
      const info = { url: 'http://localhost:7777/mcp', uiUrl: 'about:blank', servers: 4, version: '1.31.0', port: 7777 };
      b.checkHypergate = async (port) => { window.calls.push('check'); await new Promise(r => setTimeout(r, 300)); return { installed: window.hg.installed, info: window.hg.running ? info : null }; };
      b.startHypergate = async () => { window.calls.push('start'); await new Promise(r => setTimeout(r, 300)); window.hg.running = true; return info; };
      b.connectHypergate = async () => {
        window.calls.push('connect');
        f.settings.mcpServers = [...f.settings.mcpServers.filter(m => m.id !== 'hypergate'), { id: 'hypergate', name: 'Hypergate', command: '', args: [], url: info.url, token: 'scoped', enabled: true }];
        return { ...info, token: 'scoped', agent: 'nekko-agent' };
      };
      f.store.setState({ settings: { ...f.settings } });
    })()`);
    await run(`layoutFixture.store.getState().setView('connectors')`);
    await sleep(1200);
    // The first-visit guide covers the page; close it as a first-time visitor would.
    await run(`document.querySelector('[aria-label="Close Connectors guide"]')?.click()`);
    await sleep(500);
    await shot(baseline ? 'connectors-before' : 'connectors-after');
    if (baseline) return;

    await check('groups in order', `[...document.querySelectorAll('[data-connector-group]')].map(g => g.dataset.connectorGroup).join() === 'git,projects,chat,docs,gateways,messaging'`);
    await check('every catalog connector shows once', `['github','gitlab','linear','slack','discord','jira','teams','gmail','gdrive','trello','asana','todoist','clickup','tasksfile','floop'].every(k => document.querySelectorAll('[data-connector=' + k + ']').length === 1)`);
    await check('MCP servers group lists Settings servers, no secrets', `(() => { const t = document.querySelector('.view-title, main')?.ownerDocument.body.textContent; return t.includes('filesystem') && t.includes('Turned off in Settings') && !t.includes('secret-token') && !t.includes('server-filesystem'); })()`);

    // Not installed: Connect checks, then offers Get Hypergate.
    await click('Connect'); await sleep(80);
    await check('Connect checks first', `${hg}.textContent.includes('Looking for Hypergate on this computer')`);
    await shot('hypergate-checking', '[data-connector-group=gateways]');
    await sleep(600);
    await check('says not installed', `${hg}.textContent.includes('Not installed on this computer') && ${hg}.textContent.includes('Get Hypergate')`);
    await shot('hypergate-missing', '[data-connector-group=gateways]');

    // Installed, stopped: Check again finds it, offers Start.
    await run('window.hg.installed = true');
    await click('Check again'); await sleep(700);
    await check('says installed, not running', `${hg}.textContent.includes('Installed, not running') && ${hg}.textContent.includes('Start Hypergate')`);
    await shot('hypergate-stopped', '[data-connector-group=gateways]');

    // Start, then it connects (the store opens the Hypergate tab; come back to the page).
    await click('Start Hypergate'); await sleep(1200);
    await check('start then connect', `window.calls.join() === 'check,check,start,connect'`);
    await run(`layoutFixture.store.getState().setView('connectors')`); await sleep(900);
    await check('shows connected with version and servers', `${hg}.textContent.includes('Connected · v1.31.0 · 4 servers') && ${hg}.textContent.includes('Disconnect')`);
    await check('the gateway is not listed again under MCP servers', `!document.querySelector('[data-connector-group=gateways] + section')?.textContent.includes('Hypergate')`);
    await shot('hypergate-connected', '[data-connector-group=gateways]');

    win.setContentSize(390, 2000); await sleep(500);
    await run(`document.querySelector('[data-connector-group=gateways]').scrollIntoView({ block: 'start' })`); await sleep(300);
    await shot('connectors-narrow');
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
