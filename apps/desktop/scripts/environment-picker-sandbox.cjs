// Real Environment picker and question card (#2404), synthetic bridge, hidden
// isolated Electron window that never takes focus. NEKKO_TEST_LABEL=before
// captures only the shared states, for a base-revision comparison.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Run through layout-evidence-integration.cjs');
const before = process.env.NEKKO_TEST_LABEL === 'before';
const profile = path.join(out, 'profile');
app.setPath('userData', profile);
app.setPath('sessionData', profile);
// JSON for a script, with the characters that could end or break it escaped.
const js = (v) => JSON.stringify(v).replace(/[<>/\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((r, done) => done({ cancel: !/^(file:|data:|blob:)/.test(r.url) }));
  session.defaultSession.setPermissionRequestHandler((_c, _p, done) => done(false));
  const win = new BrowserWindow({ width: 900, height: 760, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -12000, y: -12000, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  const report = { checks: [], errors: [] };
  win.on('focus', () => report.errors.push('Unexpected window focus'));
  win.webContents.on('console-message', (e) => { if (e.level === 'error') report.errors.push(e.message); });
  const run = (code) => win.webContents.executeJavaScript(code, true);
  const check = (name, passed) => { report.checks.push({ name, passed: !!passed }); if (!passed) throw Error(name); };
  // A hidden window can hand back its previous frame; a one-pixel resize forces a fresh paint.
  const shot = async (name) => { win.setContentSize(901, 760); await sleep(120); win.setContentSize(900, 760); win.webContents.invalidate(); await sleep(350); fs.writeFileSync(path.join(out, name + '.png'), (await win.capturePage(undefined, { stayHidden: true })).toPNG()); };
  const click = (selector) => run(`document.querySelector(${js(selector)}).click()`);
  const clickText = (text) => run(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes(${js(text)})).click()`);
  try {
    await win.loadFile(path.join(out, 'index.html'));
    await sleep(1200);
    await shot('question-initial');
    await click('.composer-folders button');
    await sleep(400);
    await shot('menu-connected');
    if (!before) {
      check('menu is the Environment', await run('!!document.querySelector("[role=menu][aria-label=Environment]")'));
      check('Folders and Repositories sections', await run('document.body.innerText.includes("FOLDERS") || document.body.innerText.includes("Folders")') && await run('document.body.innerText.toLowerCase().includes("repositories")'));
      check('repository row named by owner/name', await run('document.body.innerText.includes("acme/atlas")'));
      check('token never rendered', await run('!document.body.innerHTML.includes("synthetic-secret-never-render")'));
      await clickText('Add repository');
      await sleep(600);
      check('repository list loaded', await run('document.body.innerText.includes("acme/billing-service")'));
      check('already-cloned repository marked', await run('document.body.innerText.includes("On this computer")'));
      await shot('menu-repositories');
      await clickText('acme/billing-service');
      await sleep(300);
      // #2561: the first repository not on this computer asks where repositories sync.
      check('sync folder asked', await run('document.body.innerText.includes("Where should repositories sync?")'));
      await shot('menu-sync-folder');
      await clickText('Use /Users/alex/nekko-repos');
      await sleep(300);
      check('sync folder saved', await run('JSON.stringify(window.integration.calls).includes("repoCloneDir")'));
      check('add in progress shown', await run('document.body.innerText.includes("Adding…")'));
      await shot('menu-cloning');
      check('clone asked for the picked repository', await run('JSON.stringify(window.integration.calls).includes("acme/billing-service")'));
      // No git provider: the section offers to connect one.
      await run('document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))');
      await sleep(200);
      await run('window.integration.setConnected(false)');
      await sleep(200);
      await click('.composer-folders button');
      await sleep(400);
      check('connect offered without a provider', await run('document.body.innerText.includes("Connect repositories")'));
      await shot('menu-not-connected');
      await run('document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))');
      await sleep(200);
      await run('window.integration.setConnected(true)');
      // The question card: the GitHub option swaps the options for the repository list.
      await clickText('Add it from GitHub or GitLab');
      await sleep(150);
      await click('[data-question-next]');
      await sleep(600);
      check('question shows the repository list', await run('!!document.querySelector("[data-question-repos]") && document.body.innerText.includes("acme/mobile")'));
      await shot('question-repositories');
      // #2561: a sandbox chat lists the repository that lives only in its sandbox.
      await run('document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))');
      await sleep(200);
      await click('[data-fixture-sandbox] .composer-folders button');
      await sleep(400);
      check('sandbox repository listed', await run('!!document.querySelector("[data-sandbox-repo]") && document.body.innerText.includes("In the sandbox")'));
      await shot('menu-sandbox-repo');
    }
  } catch (e) {
    report.errors.push(String(e && e.stack || e));
  } finally {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    win.destroy();
    app.exit(report.errors.length ? 1 : 0);
  }
});
