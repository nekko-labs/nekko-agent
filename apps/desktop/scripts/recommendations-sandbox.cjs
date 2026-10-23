// Synthetic renderer-only evidence. No host, user profile, OS input or network.
// The window is hidden, non-focusable and parked off every display.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch with recommendations-integration.cjs');
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
  const win = new BrowserWindow({ width: 1440, height: 1100, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: left - 4500, y: -3000, title: 'Isolated model recommendations verification', webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('Fixture took focus'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const check = async (name, source) => { report.checks.push({ name, passed: !!await run(source) }); };
  const capture = async name => {
    const file = path.join(dir, name + '.png');
    const image = await win.capturePage(undefined, { stayHidden: true, stayAwake: false });
    if (image.isEmpty()) throw Error('Empty capture: ' + name);
    fs.writeFileSync(file, image.toPNG()); report.captures.push({ file, size: image.getSize() });
  };
  // Both revisions scroll to the same place: the Models heading.
  const toModels = "(()=>{const h=[...document.querySelectorAll('h2')].find(e=>e.textContent.trim()==='Models');h&&h.scrollIntoView({block:'start'});return !!h})()";
  const fresh = (machine, library = []) => run(`integration.reset({machine:'${machine}',library:${JSON.stringify(library)}})`);
  try {
    await win.loadFile(path.join(out, 'index.html')); win.showInactive(); await sleep(1000);
    for (const theme of ['dark', 'light']) {
      await fresh('m5max'); await sleep(1500);
      await run(`document.documentElement.dataset.theme='${theme}'`); await run(toModels); await sleep(500);
      await capture(`fresh-m5max-${theme}`);
      await check(`${theme}: models page renders`, toModels);
      if (!base) {
        await check(`${theme}: open on a fresh install`, "document.querySelector('[data-recommendations]')?.open===true");
        await check(`${theme}: one row per task`, "document.querySelectorAll('[data-recommendation]').length===5");
      }
    }
    if (!base) {
      await fresh('m5max-here'); await sleep(1500); await run(toModels); await sleep(500);
      await capture('m5max-measured-here-dark');
      await check('measured here: says so', "document.querySelector('[data-recommendation=\"code\"] [data-speed-basis=\"measuredHere\"]')?.textContent==='98 tok/s here'");
    }
    await fresh('cpu'); await sleep(1500); await run(toModels); await sleep(500);
    await capture('fresh-cpu-only-dark');
    if (!base) {
      await check('cpu: rough speeds are labelled', "document.querySelector('[data-recommendation=\"chat\"] [data-speed-basis=\"estimatedBorrowed\"]')?.textContent.includes('rough')");
      await check('cpu: below-target tasks say so', "document.querySelector('[data-recommendation=\"code\"]').innerText.includes('Slower than the 25 tok/s')");
    }
    // A machine that already has the routing pick: folded, and the row says Downloaded.
    const routerFile = await run("integration.data.rtx4060.tasks.find(t=>t.task==='router').pick.files[0]");
    const have = [{ id: 'unsloth/Qwen3.5-2B-GGUF/' + routerFile, name: 'Qwen3.5 2B', path: '/fixture/models/chat/' + routerFile, format: 'gguf', sizeBytes: 2e9, quantization: 'Q8_0', loaded: false, readable: true }];
    await fresh('rtx4060', have); await sleep(1500); await run(toModels); await sleep(500);
    await capture('rtx4060-with-a-model-folded-dark');
    if (!base) {
      await check('rtx4060: folded once there are models', "document.querySelector('[data-recommendations]')?.open===false");
      await run("document.querySelector('[data-recommendations] summary').click()"); await sleep(400);
      await capture('rtx4060-with-a-model-opened-dark');
      await check('rtx4060: the downloaded pick is marked', "document.querySelector('[data-recommendation=\"router\"]').innerText.includes('Downloaded')");
      await run("document.querySelector('[data-recommendation=\"chat\"] button').click()"); await sleep(600);
      await check('download: queued with the catalog label', "integration.downloads.at(-1)==='unsloth/Qwen3.5-9B-GGUF Q4_K_M'");
      await check('download: the row says so', "document.querySelector('[data-recommendation=\"chat\"]').innerText.includes('Queued')");
      await run(toModels); await sleep(300);
      await capture('rtx4060-download-queued-dark');
    }
  } catch (e) { report.errors.push(String(e && e.stack || e)); }
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  const failed = report.checks.filter(c => !c.passed);
  console.log(JSON.stringify({ checks: report.checks.length, failed, errors: report.errors, blockedNetwork: report.blockedNetwork.length }, null, 2));
  app.exit(failed.length || report.errors.length ? 1 : 0);
});
