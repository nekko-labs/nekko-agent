// A chat's Sync switch, beside the message box: shown only while this computer syncs, on by default,
// and clicking it keeps the chat on this computer (syncOff). Real composer via the layout fixture's
// showFolderComposer; synthetic bridge only. Hidden, off-screen, non-focusable; renderer input only.
//   NEKKO_LAYOUT_SANDBOX=sync-switch-sandbox.cjs NEKKO_TEST_LABEL=sync-switch node apps/desktop/scripts/layout-evidence-integration.cjs
// PNGs and report.json land in .shots/sync-switch.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Use layout-evidence-integration.cjs');
const shots = path.resolve(out, '../../../.shots/sync-switch');
fs.mkdirSync(shots, { recursive: true });
app.setPath('userData', path.join(out, 'profile'));
app.setPath('sessionData', path.join(out, 'profile'));
app.disableHardwareAcceleration();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const js = (v) => JSON.stringify(v).replace(/[<>/\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const report = { checks: [], captures: [], errors: [] };
const status = (on) => ({ signedIn: true, account: { email: 'sam@example.com', plan: 'pro', canSync: true }, keysStoredIn: 'the macOS Keychain',
  sync: { phase: on ? 'idle' : 'off', enabled: on, recoveryConfirmed: true, keyEpoch: on ? 1 : null, lastSyncAt: null, error: null, progress: null, chats: 3, skipped: {}, devices: [] } });

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1100, height: 720, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -10000, y: -10000, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('show', () => report.errors.push('Became visible'));
  win.on('focus', () => report.errors.push('Took focus'));
  win.webContents.on('console-message', (e) => { if (e.level === 'error') report.errors.push('console: ' + String(e.message).slice(0, 300)); });
  const run = (code) => win.webContents.executeJavaScript(code, true);
  const check = (name, value) => report.checks.push({ name, value });
  const strip = () => run(`(()=>{const e=document.querySelector('.composer');const r=e.getBoundingClientRect();return {x:Math.max(0,Math.floor(r.x-8)),y:Math.max(0,Math.floor(r.y-8)),width:Math.ceil(r.width+16),height:Math.ceil(r.height+16)}})()`);
  const shot = async (name) => {
    const rect = await strip();
    await sleep(150);
    await win.capturePage(rect, { stayHidden: true }); // the first capture of a hidden window can be stale
    await sleep(100);
    const file = path.join(shots, name + '.png');
    fs.writeFileSync(file, (await win.capturePage(rect, { stayHidden: true })).toPNG());
    report.captures.push(file);
  };
  const scene = async (syncing, seed = '') => {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 100 && !(await run('!!window.layoutFixture')); i++) await sleep(100);
    await run(`(()=>{const h=document.documentElement;const off=()=>h.removeAttribute('data-app-inactive');off();new MutationObserver(off).observe(h,{attributes:true,attributeFilter:['data-app-inactive']})})()`);
    await sleep(900);
    await run(`layoutFixture.bridge.cloudStatus = async () => (${js(status(syncing))}); layoutFixture.bridge.onCloudStatus = () => () => {}; 0`);
    await run(`layoutFixture.composerSeed = (r) => { delete layoutFixture.settings.themePreset; ${seed} }; 0`);
    await run(`layoutFixture.showFolderComposer(false, true, 'full', '')`);
    for (let i = 0; i < 80 && !(await run(`!!document.querySelector('.composer')`)); i++) await sleep(100);
    await sleep(1200);
  };
  const toggle = `document.querySelector('[data-sync-toggle]')`;
  try {
    // 1. Syncing: the switch is there, lit.
    await scene(true);
    check('shown while this computer syncs', await run(`!!${toggle}`));
    check('on by default', await run(`${toggle}?.getAttribute('aria-pressed') === 'true'`));
    await shot('1-sync-on');
    // 2. Click: the chat keeps to this computer.
    await run(`${toggle}.click()`);
    await sleep(700);
    check('off after a click', await run(`${toggle}?.getAttribute('aria-pressed') === 'false'`));
    check('the chat records syncOff', await run(`layoutFixture.records.some((r) => r.syncOff === true)`));
    await shot('2-sync-off');
    // 3. Not syncing: no switch at all.
    await scene(false);
    check('hidden when sync is off for this computer', await run(`!${toggle}`));
    await shot('3-not-syncing');
    // 4. Incognito: never synced, so no switch.
    await scene(true, 'r.incognito = true;');
    check('hidden on an incognito chat', await run(`!${toggle}`));
  } catch (e) {
    report.errors.push(String(e && e.stack || e));
  }
  fs.writeFileSync(path.join(shots, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.checks));
  if (report.errors.length) console.log('errors:', report.errors.join('\n'));
  app.exit(report.errors.length || report.checks.some((c) => !c.value) ? 1 : 0);
});
