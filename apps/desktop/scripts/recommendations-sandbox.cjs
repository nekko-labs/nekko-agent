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
        await check(`${theme}: a fresh install opens on Find new models, picks first`, "document.querySelector('[data-models-mode]')?.dataset.modelsMode==='find' && !!document.querySelector('[data-recommendations]')");
        await check(`${theme}: one row per task`, "document.querySelectorAll('[data-recommendation]').length===5");
      }
    }
    await run("document.documentElement.dataset.theme='dark'");
    if (!base) {
      await fresh('m5max-here'); await sleep(1500); await run(toModels); await sleep(500);
      await capture('m5max-measured-here-dark');
      await check('measured here: says so', "document.querySelector('[data-recommendation=\"code\"] [data-speed-basis=\"measuredHere\"]')?.textContent==='98 tok/s here'");
    }
    if (!base) {
      // A new GPU, with the 8 GB card's coding pick already downloaded.
      const upgradeHave = await run('integration.data.rtx4080upgradeHave');
      await fresh('rtx4080upgrade', [{ id: 'chat/' + upgradeHave.split('/').pop(), name: 'Qwen3.5 4B', path: upgradeHave, format: 'gguf', sizeBytes: 2.7e9, quantization: 'Q4_K_M', loaded: false, readable: true }]);
      await sleep(1500); await run(toModels); await sleep(500);
      await capture('rtx4080-upgrade-nudge-dark');
      await check('upgrade: said on the models on this machine, picks left to Find', "document.querySelector('[data-models-mode]')?.dataset.modelsMode==='installed' && !!document.querySelector('[data-upgrade-nudges]') && !document.querySelector('[data-recommendations]')");
      await check('upgrade: titled for the new GPU', "document.querySelector('[data-upgrade-nudges]').innerText.includes('Better models now fit your 16 GB GPU')");
      await run("[...document.querySelectorAll('[data-upgrade-nudges] button')].find(b=>b.textContent.trim()==='Not now').click()"); await sleep(400);
      await check('upgrade: Not now dismisses it', "!document.querySelector('[data-upgrade-nudges]') && integration.dismissed.length===1");
    }
    await fresh('cpu'); await sleep(1500); await run(toModels); await sleep(500);
    await capture('fresh-cpu-only-dark');
    if (!base) {
      await check('cpu: rough speeds are labelled', "document.querySelector('[data-recommendation=\"chat\"] [data-speed-basis=\"estimatedBorrowed\"]')?.textContent.includes('rough')");
      await check('cpu: below-target tasks say so', "document.querySelector('[data-recommendation=\"code\"]').innerText.includes('Slower than the 25 tok/s')");
    }
    // A machine that already has the routing pick, and a file whose last load failed.
    const routerFile = await run("integration.data.rtx4060.tasks.find(t=>t.task==='router').pick.files[0]");
    const have = [
      { id: 'unsloth/Qwen3.5-2B-GGUF/' + routerFile, name: 'Qwen3.5 2B', path: '/fixture/models/chat/' + routerFile, format: 'gguf', sizeBytes: 2e9, quantization: 'Q8_0', parameterSize: '2B', loaded: false, readable: true },
      { id: 'Ckpt_Q38.gguf', name: 'Ckpt_Q38', path: '/fixture/models/Ckpt_Q38.gguf', format: 'gguf', sizeBytes: 3.9e9, quantization: 'Q8_0', parameterSize: '1.4B', maxContext: 262144, modality: 'vision', hasProjector: true, loaded: false, readable: true, lastLoadError: "The file doesn't match what llama.cpp expects (a tensor is missing or unexpected). Re-download it, or pick a different build of the model." },
    ];
    await fresh('rtx4060', have); await sleep(1500); await run(toModels); await sleep(500);
    await capture('rtx4060-on-this-machine-dark');
    if (!base) {
      await check('rtx4060: opens on the models on this machine once there are some', "document.querySelector('[data-models-mode]')?.dataset.modelsMode==='installed' && !document.querySelector('[data-recommendations]')");
      await check('failed load: a warning, not a check', "(()=>{const r=document.querySelector('[data-model-family=\"ckpt\"]');return !!r && !!r.querySelector('[data-family-problem]') && r.innerText.includes('Last load failed') && !r.querySelector('[aria-label=\"Downloaded\"]')})()");
      await run("document.querySelector('[data-models-mode-option=\"find\"]').click()"); await sleep(600); await run(toModels); await sleep(300);
      await capture('rtx4060-find-new-models-dark');
      await check('rtx4060: Find new models leads with the picks', "!!document.querySelector('[data-recommendations]')");
      await check('rtx4060: the downloaded pick is marked', "document.querySelector('[data-recommendation=\"router\"]').innerText.includes('Downloaded')");
      await check('rtx4060: each pick says what fits', "document.querySelectorAll('[data-recommendation] [data-context-fit]').length>=4");
      await run("document.querySelector('[data-recommendation=\"chat\"] [data-quants-toggle]').click()"); await sleep(500);
      await check('quants: the table opens with the pick marked', "(()=>{const t=document.querySelector('[data-recommendation=\"chat\"] [data-quant-table]');return !!t && t.querySelectorAll('tbody tr').length>1 && t.innerText.includes('pick')})()");
      await capture('rtx4060-quants-open-dark');
      await run("document.querySelector('[data-recommendation=\"chat\"] [data-quants-toggle]').click()"); await sleep(400);
      await run("[...document.querySelector('[data-recommendation=\"chat\"]').querySelectorAll('button')].find(b=>b.textContent.trim()==='Download').click()"); await sleep(600);
      await check('download: queued with the catalog label', "integration.downloads.at(-1)==='unsloth/Qwen3.5-9B-GGUF Q4_K_M'");
      await check('download: the row says so', "/Queued|Downloading/.test(document.querySelector('[data-recommendation=\"chat\"]').innerText)");
      await run(toModels); await sleep(300);
      await capture('rtx4060-download-queued-dark');
    }
  } catch (e) { report.errors.push(String(e && e.stack || e)); }
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  const failed = report.checks.filter(c => !c.passed);
  console.log(JSON.stringify({ checks: report.checks.length, failed, errors: report.errors, blockedNetwork: report.blockedNetwork.length }, null, 2));
  app.exit(failed.length || report.errors.length ? 1 : 0);
});
