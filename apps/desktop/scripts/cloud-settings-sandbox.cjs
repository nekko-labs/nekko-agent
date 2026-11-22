// Hidden synthetic Cloud settings journey. Use layout-evidence-integration.cjs.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Missing evidence directory');
app.setPath('userData', path.join(out, 'profile'));
const before = process.env.NEKKO_CLOUD_SETTINGS_BASELINE === '1';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = [];
const unsafe = new RegExp('[<>/' + String.fromCharCode(0x2028, 0x2029) + ']', 'g');
const js = (v) => JSON.stringify(v).replace(unsafe, (c) => String.fromCharCode(92) + 'u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
function stub(scenario) {
  const f = window.layoutFixture;
  f.settings.guardrails = [];
  f.bridge.telemetryStatus = async () => ({ configured: false });
  f.store.setState({ settings: { ...f.store.getState().settings, guardrails: [] } });
  f.bridge.engineModels = async () => [];
  f.bridge.listRemoteDevices = async () => [];
  f.bridge.getRemoteStatus = async () => ({ enabled: false });
  const initial = { signedIn: true, keysStoredIn: 'Windows Credential Manager', account: { plan: 'pro', email: 'you@example.com' }, sync: { phase: scenario === 'restore' ? 'needs-join' : 'idle', enabled: true, recoveryConfirmed: true, keyEpoch: 1, devices: [], skipped: {} } };
  let state = initial;
  const org = { id: 'old', name: 'First fleet', role: 'owner', hasKey: true, sharing: false, members: [], invites: [] };
  let list = ['missing', 'populated'].includes(scenario) ? [org] : [];
  window.fleetScenario = scenario;
  f.bridge.cloudStatus = f.bridge.cloudRefresh = async () => state;
  f.bridge.onCloudStatus = () => () => {};
  f.bridge.syncRequestJoin = async () => (state = { ...initial, sync: { ...initial.sync, phase: 'awaiting-approval', joinCode: 'TEST-ONLY-CODE-0000' } });
  f.bridge.syncRestore = () => new Promise((resolve, reject) => { window.finishRestore = (ok) => {
    if (!ok) return reject(new Error('That recovery key did not work.'));
    state = { ...initial, sync: { ...initial.sync, phase: 'idle' } }; resolve(state);
  }; });
  f.bridge.orgList = async () => {
    if (window.fleetScenario === 'unavailable') throw Error("That organization wasn't found.");
    return { orgs: list, invites: [] };
  };
  f.bridge.orgGet = async (id) => {
    if (window.fleetScenario === 'missing' && id === 'old') throw Error("That organization wasn't found.");
    return list.find((x) => x.id === id);
  };
  f.bridge.fleetList = async () => ({ computers: [] });
  f.bridge.orgCreate = (name) => new Promise((resolve, reject) => { window.finishCreate = (ok) => {
    if (!ok) return reject(Error('Try again in a moment.'));
    const created = { ...org, id: 'new', name }; list = [...list, created]; resolve(created);
  }; });
}
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1200, height: 900, x: -5000, y: -5000, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const errors = [];
  win.on('focus', () => errors.push('Fixture took focus'));
  win.webContents.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message.slice(0, 1400) + " " + e.sourceId + ":" + e.lineNumber); });
  const run = (s) => win.webContents.executeJavaScript('(async () => { const r = await (' + s + '); return r instanceof Element ? true : r; })()', true);
  const wait = async (s) => { for (let i = 0; i < 60; i++) { if (await run(s)) return; await sleep(100); } throw Error('Timed out: ' + s); };
  const check = async (name, s) => { await wait(s); checks.push(name); };
  const q = (id) => 'document.querySelector(' + js('[data-testid=' + id + ']') + ')';
  const click = (id) => run(q(id) + '.click()');
  function fillField(el, value) {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const fill = (id, value) => run('(' + fillField + ')(' + q(id) + ',' + js(value) + ')');
  function scrollSection(id) {
    const el = document.getElementById(id);
    const pane = el.closest('.settings-content');
    pane.scrollTop += el.getBoundingClientRect().top - pane.getBoundingClientRect().top - 12;
  }
  const show = (id) => run('(' + scrollSection + ')(' + js(id) + ')');
  const capture = () => win.capturePage(undefined, { stayHidden: true }).then((image) => image.toPNG());
  const shot = async (name) => { win.webContents.invalidate(); await sleep(250); fs.writeFileSync(path.join(out, name + '.png'), await capture()); };
  async function open(scenario, target) {
    await run("layoutFixture.store.setState({ view:'chat' })");
    await sleep(150);
    await run('(' + stub + ')(' + js(scenario) + ')');
    await run("layoutFixture.store.setState({ view:'settings' })");
    await wait(q(target));
  }
  try {
    await win.loadFile(path.join(out, 'index.html'));
    await wait('!!window.layoutFixture');
    for (const [label, width] of [['wide', 1200], ['narrow', 390]]) {
      win.setContentSize(width, 900);
      await open('restore', 'sync-request-join');
      await show('sync');
      await shot('sync-setup-' + label);
      if (!before) {
        await check(label + ' recovery is an explicit fallback', '!' + q('sync-restore-key') + ' && ' + q('sync-request-join') + '.classList.contains("btn-primary")');
        await click('sync-request-join');
        await check(label + ' device approval shows a code', q('sync-join-code') + '?.textContent === "TEST-ONLY-CODE-0000"');
        await click('sync-recovery-open');
        await wait(q('sync-restore-key'));
        await click('sync-recovery-back');
        await check(label + ' returning keeps approval active', q('sync-join-code') + '?.textContent === "TEST-ONLY-CODE-0000"');
        await open('restore', 'sync-recovery-open');
        await click('sync-recovery-open');
      }
      await show('sync');
      await fill('sync-restore-key', 'X'.repeat(55));
      await wait('!' + q('sync-restore') + '.disabled');
      const frames = !before && label === 'wide' ? [await capture()] : null;
      await click('sync-restore');
      await check(label + ' pending label', q('sync-restore') + '.disabled && ' + q('sync-restore') + '.textContent.includes(' + js(before ? 'Unlock' : 'Checking recovery key') + ')');
      if (frames) for (let i = 0; i < 6; i++) { await sleep(100); frames.push(await capture()); }
      await shot('sync-checking-' + label);
      await run('window.finishRestore(false)');
      await check(label + ' invalid key and retry', '!' + q('sync-restore') + '.disabled && !!document.querySelector("#sync [role=alert]")');
      await click('sync-restore');
      await wait(q('sync-restore') + '.disabled');
      await run('window.finishRestore(true)');
      await check(label + ' reached sync', q('sync-now') + ' && !' + q('sync-restore'));
      if (frames) { for (let i = 0; i < 6; i++) { await sleep(100); frames.push(await capture()); } require('./evidence-gif.cjs')(path.join(out, 'sync-recovery-motion.gif'), frames, 13); }
      for (const [scenario, target] of [['unavailable', 'org-error'], ['empty', before ? 'org-create' : 'org-create-open'], ['missing', 'org-error'], ['populated', 'org-name']]) {
        await open(scenario, target);
        await show('organization');
        await shot('fleet-' + scenario + '-' + label);
        if (before) continue;
        if (scenario === 'unavailable') {
          await check(label + ' outage is not an empty list', q('org-error') + '.textContent.includes("Nekko Cloud") && !' + q('org-create-open'));
          await run('window.fleetScenario = "empty"');
          await click('org-retry');
          await wait(q('org-create-open'));
          continue;
        }
        await click('org-create-open');
        await check(label + ' ' + scenario + ' create field opens', q('org-create-name'));
        if (scenario === 'missing') await shot('fleet-form-' + label);
        await fill('org-create-name', '  Studio fleet  ');
        await click('org-create-submit');
        await wait(q('org-create-submit') + '.textContent.includes("Creating")');
        await run('window.finishCreate(false)');
        await check(label + ' create failure retains name', q('org-create-error') + ' && ' + q('org-create-name') + '.value === "  Studio fleet  "');
        await click('org-create-submit');
        await wait(q('org-create-submit') + '.textContent.includes("Creating")');
        await run('window.finishCreate(true)');
        await check(label + ' new fleet selected and private', q('org-name') + '?.textContent === "Studio fleet" && !' + q('org-create') + ' && ' + q('org-body') + '?.querySelector("[role=switch]")?.getAttribute("aria-checked") === "false"');
        if (scenario === 'missing') await shot('fleet-created-' + label);
      }
    }
    if (win.isVisible()) throw Error('Fixture became visible');
  } catch (e) { errors.push(e.stack || String(e)); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ checks, errors }, null, 2));
  console.log(JSON.stringify({ checks, errors }));
  app.exit(errors.length ? 1 : 0);
});
