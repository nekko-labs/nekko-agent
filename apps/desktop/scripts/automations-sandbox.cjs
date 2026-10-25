// Synthetic renderer-only evidence for the automations' run policy. No host,
// user profile, OS input or network. The window is hidden, non-focusable and
// parked off every display.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch with automations-integration.cjs');
const base = !!process.env.NEKKO_TEST_REVISION;
const dir = path.join(out, base ? 'before' : 'after');
fs.mkdirSync(dir, { recursive: true });
const profile = fs.mkdtempSync(path.join(dir, 'profile-'));
app.setPath('userData', profile);
app.setPath('sessionData', profile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const report = { revision: process.env.NEKKO_TEST_REVISION || 'working-tree', checks: [], errors: [], captures: [], blockedNetwork: [] };
  session.defaultSession.webRequest.onBeforeRequest((r, done) => {
    const cancel = !/^(file:|data:|blob:)/.test(r.url);
    if (cancel) report.blockedNetwork.push(r.url);
    done({ cancel });
  });
  session.defaultSession.setPermissionRequestHandler((_c, _p, done) => done(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  const left = Math.min(...screen.getAllDisplays().map(d => d.bounds.x));
  const win = new BrowserWindow({ width: 1280, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: left - 4500, y: -3000, title: 'Isolated automations verification', webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('Fixture took focus'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const check = async (name, source) => { report.checks.push({ name, passed: !!await run(source) }); };
  const capture = async name => {
    const image = await win.capturePage(undefined, { stayHidden: true, stayAwake: false });
    if (image.isEmpty()) throw Error('Empty capture: ' + name);
    const file = path.join(dir, name + '.png');
    fs.writeFileSync(file, image.toPNG()); report.captures.push({ file, size: image.getSize() });
  };
  const show = async (scene, theme) => {
    await run(`integration.show('${scene}')`); await sleep(900);
    await run(`document.documentElement.dataset.theme='${theme}'`); await sleep(300);
  };
  // Both revisions scroll to the same place: the editor's Runs heading.
  const toRuns = "(()=>{const h=[...document.querySelectorAll('h3')].find(e=>e.textContent.trim()==='Runs');h&&h.scrollIntoView({block:'start'});return !!h})()";
  try {
    await win.loadFile(path.join(out, 'index.html')); win.showInactive(); await sleep(1000);
    for (const theme of ['dark', 'light']) {
      await show('workflows', theme);
      await run("document.querySelector('[data-workflow-row=\"wf-local\"] button[aria-expanded]').click()"); await sleep(500);
      await capture(`workflows-${theme}`);
      await check(`${theme}: workflows list renders`, "!!document.querySelector('[data-workflow-row=\"wf-local\"]')");
      if (!base) {
        await check(`${theme}: the held schedule says it waits`, "document.querySelector('[data-workflow-row=\"wf-local\"] [data-workflow-waiting]')?.textContent.includes('waiting for you to be away')");
        await check(`${theme}: the event workflow does not`, "!document.querySelector('[data-workflow-row=\"wf-review\"] [data-workflow-waiting]')");
        await check(`${theme}: a capped run says how it started`, "document.querySelector('[data-run-id=\"r3\"] [data-run-policy-note]')?.textContent.includes('low priority · waited 2 hr')");
      }
      await show('editor', theme); await run(toRuns); await sleep(300);
      await capture(`editor-runs-${theme}`);
      await check(`${theme}: editor renders its Runs section`, toRuns);
      if (!base) {
        await check(`${theme}: a local workflow defaults to waiting`, "document.querySelector('[data-run-policy]')?.selectedOptions[0].textContent==='Default: Only when I’m away'");
      }
      await show('pane', theme);
      await capture(`automations-pane-${theme}`);
      if (!base) {
        await check(`${theme}: the held task says it waits`, "document.querySelector('[data-task-row=\"t1\"] [data-task-state]')?.textContent==='waiting for you to be away'");
        await check(`${theme}: a capped task run says so`, "document.querySelector('[data-task-row=\"t2\"]').innerText.includes('low priority · waited 2 hr')");
      }
      await show('modal', theme);
      await capture(`automate-modal-${theme}`);
      if (!base) await check(`${theme}: the Automate modal offers when it runs`, "!!document.querySelector('[data-run-policy]')");
      await show('settings', theme);
      await capture(`settings-automations-${theme}`);
      if (!base) {
        await check(`${theme}: settings has an Automations section`, "!!document.querySelector('[data-settings-automations]')");
        await check(`${theme}: the default is by where the model runs`, "document.querySelector('[data-settings-run-policy]').selectedOptions[0].textContent==='By where the model runs'");
      }
    }
    // The resource chip and the Agent board's monitors, with one automation
    // paused for the user and then one running (both revisions).
    for (const [label, bg] of [['paused', { running: 1, paused: 1, reason: 'active' }], ['running', { running: 1, paused: 0, reason: null }]]) {
      for (const theme of ['dark', 'light']) {
        await run(`integration.setBackground(${JSON.stringify(bg)})`);
        await show('hud', theme); await sleep(600);
        await capture(`hud-background-${label}-${theme}`);
        await show('dock', theme); await sleep(600);
        await capture(`dock-background-${label}-${theme}`);
        if (!base) {
          await show('hud', theme); await sleep(600);
          await check(`${theme}: the resource chip says ${label}`, `document.querySelector('[data-background-chip="${label}"]')?.textContent.includes('BG')`);
          await show('dock', theme); await sleep(600);
          await check(`${theme}: the monitors say ${label}`, `document.querySelector('[data-dock-scene] [data-background-chip="${label}"]')?.textContent.startsWith('Background: 1 ${label}')`);
        }
      }
    }
    await run(`integration.setBackground({ running: 0, paused: 0, reason: null })`);
    if (!base) {
      await show('hud', 'dark'); await sleep(600);
      await check('nothing in the background: no chip', "!document.querySelector('[data-background-chip]')");
    }
    if (!base) {
      for (const theme of ['dark', 'light']) {
        await show('paused', theme); await sleep(400);
        await capture(`reply-paused-${theme}`);
        await check(`${theme}: a paused reply says so`, "document.querySelector('[data-paused-status]')?.textContent.includes('Status: Paused')");
        await check(`${theme}: and drops what it had half written`, "!document.body.innerText.includes('dependency bu')");
      }
      // Picking a policy in the editor changes the hint with it.
      await show('editor', 'dark'); await run(toRuns);
      await run("(()=>{const s=document.querySelector('[data-run-policy]');const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;set.call(s,'lowPriority');s.dispatchEvent(new Event('change',{bubbles:true}))})()"); await sleep(300);
      await check('editor: low priority explains itself', "document.querySelector('[data-run-policy-hint]').textContent.startsWith('Runs on time, even while you work')");
      await capture('editor-runs-low-priority-dark');
    }
  } catch (e) { report.errors.push(String(e && e.stack || e)); }
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  const failed = report.checks.filter(c => !c.passed);
  console.log(JSON.stringify({ checks: report.checks.length, failed, errors: report.errors, blockedNetwork: report.blockedNetwork.length }, null, 2));
  app.exit(failed.length || report.errors.length ? 1 : 0);
});
