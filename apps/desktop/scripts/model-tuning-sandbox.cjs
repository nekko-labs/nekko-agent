// Synthetic renderer-only evidence for the load drawer. No host, user profile,
// OS input or network. The window is hidden, non-focusable and never shown.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch with model-tuning-integration.cjs');
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
  const win = new BrowserWindow({ width: 820, height: 1200, useContentSize: true, show: false, focusable: false, skipTaskbar: true, title: 'Isolated load drawer verification', webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('Fixture took focus'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const check = async (name, source) => { report.checks.push({ name, passed: !!await run(source) }); };
  const click = async selector => { const ok = await run(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;e.click();return true})()`); if (!ok) report.errors.push('Missing ' + selector); await sleep(700); };
  const clickText = async text => { await run(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()===${JSON.stringify(text)})?.click()`); await sleep(700); };
  const capture = async name => {
    const height = Math.min(4000, Math.ceil(await run('document.documentElement.scrollHeight')));
    win.setContentSize(820, height); await sleep(500);
    const file = path.join(dir, name + '.png');
    const image = await win.capturePage(undefined, { stayHidden: true, stayAwake: false });
    if (image.isEmpty()) throw Error('Empty capture: ' + name);
    fs.writeFileSync(file, image.toPNG()); report.captures.push({ file, size: image.getSize() });
    win.setContentSize(820, 1200);
  };
  const reset = async opts => { await run(`integration.reset(${JSON.stringify(opts)})`); await sleep(1500); };
  try {
    await win.loadFile(path.join(out, 'index.html')); await sleep(1000);
    if (base) {
      await reset({ scenario: 'moe8' }); await capture('moe8-open');
      await clickText('Advanced'); await capture('moe8-advanced');
      await reset({ scenario: 'dense24' }); await capture('dense24-open');
    } else {
      await reset({ scenario: 'moe8' });
      await capture('moe8-open');
      await check('opens on the recommended setup', "document.querySelector('[data-engine-load-drawer]').innerText.includes('What this chose')");
      await check('meter shows VRAM and RAM bars', "document.querySelectorAll('[data-meter-bar]').length===2");
      await check('the n-gram table is on the SSD', "document.querySelector('[data-meter-disk]')?.innerText.includes('SSD')");
      await check('fixture planner matches the Rust planner for the recommended request', "(()=>{const d=integration.data.moe8;const p=integration.place(d.speed.request);return p.verdict===d.speedPlace.verdict&&Math.abs(p.vram.model.weightsBytes-d.speedPlace.vram.model.weightsBytes)<1e6&&Math.abs(p.vram.model.overheadBytes-d.speedPlace.vram.model.overheadBytes)<1e6})()");
      await click('[data-run-on="gpu"]');
      await capture('moe8-gpu-only');
      await check('GPU only does not fit on 8 GB', "document.querySelector('[data-verdict]')?.dataset.verdict==='wont-load'");
      await click('[data-run-on="hybrid"]');
      await click('[data-preset="coding"]'); await sleep(800);
      await capture('moe8-coding-preset');
      await check('long coding keeps the full context', "document.querySelector('[data-context-label]')?.innerText.startsWith('256k')");
      await click('[data-fold="more"]'); await click('[data-fold="expert"]');
      await capture('moe8-more-and-expert');
      await check('expert controls name their flags', "document.querySelector('[data-engine-load-drawer]').innerText.includes('--n-cpu-moe')");
      await click('[data-load]'); await sleep(500);
      await check('load sends experts in RAM and paged tables', "(()=>{const l=integration.loads().at(-1);return !!l&&l.cpuMoeLayers>0&&l.lazyTables===true&&l.contextTokens===262144})()");
      await reset({ scenario: 'dense24' });
      await capture('dense24-open');
      await check('a dense model that fits runs on the GPU', "document.querySelector('[data-run-on=\"gpu\"]')?.getAttribute('aria-pressed')==='true'");
      await check('MoE presets are not offered for a dense model', "!document.querySelector('[data-preset]')");
      await reset({ scenario: 'dense8' });
      await capture('dense8-open');
      await check('a dense model too big for 8 GB moves feed-forward to RAM', "document.querySelector('[data-engine-load-drawer]').innerText.includes('Feed-forward')");
    }
  } catch (e) { report.errors.push(String(e && e.stack || e)); }
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ checks: report.checks, errors: report.errors, blocked: report.blockedNetwork.length }, null, 1));
  app.exit(report.errors.length || report.checks.some(c => !c.passed) ? 1 : 0);
});
