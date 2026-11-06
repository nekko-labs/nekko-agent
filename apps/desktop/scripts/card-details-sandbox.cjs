// Actual App + synthetic data, never the user's host. Run through layout-evidence-integration.cjs.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], checks: [], errors: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const minX = Math.min(...screen.getAllDisplays().map(d => d.bounds.x));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: minX - 1700, y: -1100, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => { report.errors.push('took focus'); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const shot = async name => { const f = path.join(out, name + '.png'); fs.writeFileSync(f, (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG()); report.captures.push(f); };
  const ready = async () => { for (let i = 0; i < 60 && !(await run("!!document.querySelector('[title=\"View options: group, sort and show\"]')")); i++) await sleep(200); await sleep(600); };
  const click = async expr => { await run(`(() => { const e = ${expr}; if (!e) throw Error('Missing control'); e.click(); })()`); await sleep(180); };
  const menu = async () => { if (!(await run("!!document.querySelector('[data-agent-view-menu]')"))) await click(`document.querySelector('[title="View options: group, sort and show"]')`); await click(`document.querySelector('[data-view-menu-row="details"]')`); };
  const seed = async () => { await run(`(() => {
    const st = layoutFixture.store; const s = st.getState();
    st.setState({ sessions: s.sessions.map((c,i) => ({ ...c, exchangeCount: 1, transcriptTokens: 42000, lastReplyAt: Date.now()-60000, modelId: 'claude-opus-4-7' })), models: [{ id: 'claude-opus-4-7', contextLength: 200000 }], prsBySession: { a: [{ url: 'https://github.com/example/project/pull/42', owner: 'example', repo: 'project', number: 42, title: 'Synthetic PR for card evidence', state: 'open', isDraft: false }] } });
  })()`); await sleep(300); };
  try {
    await win.loadFile(path.join(out, 'index.html')); await ready();
    await run(`localStorage.setItem('nekko.agentPanelView', JSON.stringify({groupBy:'none'})); location.reload()`).catch(() => {});
    await sleep(500); await ready(); await seed();
    await shot('cards-default');
    await click(`document.querySelector('[title="View options: group, sort and show"]')`);
    const after = await run(`!!document.querySelector('[data-view-menu-row="details"]')`);
    await click(`document.querySelector('[data-view-menu-row="${after ? 'details' : 'show'}"]')`);
    await shot('cards-menu');
    if (after) {
      for (const [label, key, selector] of [['Model','showModel','[title$="/ claude-opus-4-7"]'],['Context window','showContext','[title^="Context window:"]'],['Pull requests','showPullRequests','[data-session-pr-chip]'],['Last reply time','showUpdated','time']]) {
        const present = await run(`!!document.querySelector('.agent-chip ${selector}')`);
        // Last reply time is plain text, so its independent visibility is covered by the renderer unit matrix.
        if (key !== 'showUpdated' && !present) throw Error(`Missing baseline fact: ${label}`);
        await menu();
        await click(`Array.from(document.querySelectorAll('[role="menuitemcheckbox"]')).find(e => e.textContent.trim() === ${JSON.stringify(label)})`);
        const saved = await run(`JSON.parse(localStorage.getItem('nekko.agentPanelView'))[${JSON.stringify(key)}]`);
        if (saved !== false) throw Error(`${key} did not persist off`);
        const absent = await run(`!document.querySelector('.agent-chip ${selector}')`);
        if (!absent) throw Error(`${label} remained visible`);
        report.checks.push(`${label}: hidden independently and saved`);
      }
      await click(`document.querySelector('[data-agent-view-menu]')`); // no mutation of the host
      await run(`document.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true }))`);
      await shot('cards-details-hidden');
      await run('location.reload()').catch(() => {}); await sleep(500); await ready(); await seed();
      if (await run(`!!document.querySelector('.agent-chip [title^="Context window:"]')`)) throw Error('Context reappeared after reload');
      report.checks.push('choices survive reload');
    }
    await run(`localStorage.setItem('nekko.agentPanelView', JSON.stringify({groupBy:'none'})); location.reload()`).catch(() => {});
    await sleep(500); await ready(); await seed();
    win.setContentSize(430, 900); await sleep(400);
    await click(`document.querySelector('[title="View options: group, sort and show"]')`);
    await click(`document.querySelector('[data-view-menu-row="${after ? 'details' : 'show'}"]')`);
    const fits = await run(`Array.from(document.querySelectorAll('[role="menu"]')).every(e => { const r=e.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; })`);
    if (!fits) throw Error('Narrow menu clipped outside viewport');
    report.checks.push('430px menu fits viewport');
    await shot('cards-narrow');
    report.hidden = !win.isVisible(); report.bounds = win.getBounds();
    if (!report.hidden) throw Error('sandbox became visible');
  } catch (e) { report.errors.push(String(e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.errors.length ? 1 : 0);
});
