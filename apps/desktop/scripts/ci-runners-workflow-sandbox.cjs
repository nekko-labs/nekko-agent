// Frame 9 in the real App: Connect to a workflow opens a new chat with the message waiting, unsent.
// Hidden and non-focusable. Run with:
// NEKKO_LAYOUT_FIXTURE=ci-runners-workflow-fixture.tsx NEKKO_LAYOUT_SANDBOX=ci-runners-workflow-sandbox.cjs NEKKO_TEST_LABEL=ci-runners-workflow node apps/desktop/scripts/layout-evidence-integration.cjs
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
// A fresh profile each run: session ids repeat here, and a parked draft would come back under the same id.
fs.rmSync(path.join(out, 'profile'), { recursive: true, force: true });
app.setPath('userData', path.join(out, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { captures: [], checks: {}, errors: [] };
const view = { config: { id: 'r1', scope: { kind: 'repo', owner: 'nekko-labs', repo: 'nekko-agent' }, label: 'nekko-cloud-mac', settings: {} }, repos: [] };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const minX = Math.min(...screen.getAllDisplays().map(d => d.bounds.x)), minY = Math.min(...screen.getAllDisplays().map(d => d.bounds.y));
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: minX - 1700, y: minY - 1100, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('took focus'));
  win.on('show', () => report.errors.push('was shown'));
  const run = s => win.webContents.executeJavaScript(s, true);
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 50 && !(await run("!!window.layoutFixture && !!window.connectToWorkflow && !!document.querySelector('.rail')")); i++) await sleep(200);
    await sleep(900);
    for (const theme of ['light', 'dark']) {
      await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      const before = await run('layoutFixture.store.getState().activeSessionId');
      await run(`connectToWorkflow(${JSON.stringify(view)})`);
      await sleep(1200);
      // The first visit to the board opens a tour over the composer.
      await run("[...document.querySelectorAll('[role=dialog] button')].find(b=>/close|skip/i.test(b.getAttribute('aria-label')||b.textContent))?.click()");
      await sleep(400);
      const state = JSON.parse(await run(`JSON.stringify((()=>{const s=layoutFixture.store.getState();const id=s.activeSessionId;const box=[...document.querySelectorAll('textarea,[contenteditable]')].find(e=>(e.value??e.innerText).includes('Connect my Mac runner'));return {id,view:s.view,seedLeft:s.composerSeed,composer:box&&(box.value??box.innerText),sent:!!layoutFixture.lastSend}})())`));
      report.checks[theme] = { ...state, before, isNewChat: state.id !== before };
      fs.writeFileSync(path.join(out, `agents-seeded-${theme}.png`), (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG());
      report.captures.push(`agents-seeded-${theme}.png`);
    }
  } catch (e) { report.errors.push(String(e && e.stack || e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  const once = c => c.composer && c.composer.split('Connect my Mac runner').length === 2;
  const ok = Object.values(report.checks).length === 2 && Object.values(report.checks).every(c => c.isNewChat && once(c) && !c.sent && !c.seedLeft) && !report.errors.length;
  app.exit(ok ? 0 : 1);
});
