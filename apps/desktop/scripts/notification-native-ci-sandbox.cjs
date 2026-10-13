require('./notification-native-ci.cjs').assertDisposableDesktop();
const { app, BrowserWindow, Notification } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const out = process.env.NEKKO_NATIVE_NOTIFICATION_OUT;
const isolated = process.env.NEKKO_NATIVE_NOTIFICATION_PROFILE;
if (!out || !isolated) throw Error('Use notification-native-ci.cjs');
app.setPath('userData', path.join(isolated, 'profile'));
app.setPath('sessionData', path.join(isolated, 'profile'));
app.disableHardwareAcceleration();
app.setAppUserModelId('dev.nekkolabs.nekkoagent.notificationacceptance');
app.on('window-all-closed', () => {});
const results = { status: 'running', events: [], osDelivery: false, clicked: false, focused: false, scope: 'Disposable CI fixture, not installed-app identity or production deep-link routing' };
let window, toast;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (!fn()) { if (Date.now() > end) throw Error('Unsupported or failed disposable desktop: ' + label); await sleep(50); }
}
function desktop(action, marker, handle = '') {
  return new Promise((resolve, reject) => {
    const child = cp.spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'notification-native-ci-desktop.ps1'), '-Action', action, '-Out', out, '-Marker', marker, '-Handle', handle], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => { output += data; console.log(String(data)); });
    child.stderr.on('data', data => { output += data; console.error(String(data)); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output) : reject(Error('Desktop probe failed (' + action + '): ' + output)));
  });
}
async function main() {
  await app.whenReady();
  results.supported = Notification.isSupported();
  assert.equal(results.supported, true, 'Electron Notification unsupported');
  const marker = 'Nekko CI toast ' + Date.now();
  results.marker = marker;
  // Hidden and nonfocusable until a real OS click, only on this disposable runner.
  window = new BrowserWindow({ show: false, focusable: false, width: 600, height: 300, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadURL('data:text/html,<title>Disposable CI notification focus target</title><h1>Native toast click target</h1>');
  await desktop('baseline', marker);
  await desktop('setup', marker);
  const setup = JSON.parse(fs.readFileSync(path.join(out, 'setup-state-after.json'), 'utf8').replace(/^\uFEFF/, ''));
  assert.equal(setup.dnd, 'Off', 'DND must be explicitly off before sending');
  assert.equal(setup.deliveryAllowed, true, 'Notification delivery prerequisite not established');
  results.setup = setup;
  toast = new Notification({ title: marker, body: 'Disposable CI only: click to focus isolated fixture.', silent: true, timeoutType: 'never' });
  toast.on('show', () => { results.events.push({ event: 'show', at: Date.now() }); });
  toast.on('failed', (_event, error) => { results.events.push({ event: 'failed', error: String(error), at: Date.now() }); results.failure = String(error); });
  toast.on('click', () => {
    results.events.push({ event: 'click', at: Date.now() }); results.clicked = true;
    window.setFocusable(true); window.show(); window.focus();
  });
  toast.show();
  await until(() => results.events.some(e => e.event === 'show') || results.failure, 'Electron show/failed event');
  assert.ok(!results.failure, 'Electron notification failed: ' + results.failure);
  // show is not proof of delivery. UIA must find visible unique text and perform an OS click.
  await desktop('toast', marker);
  results.osDelivery = true;
  await until(() => results.clicked, 'OS click did not reach Electron Notification click event');
  await until(() => window.isFocused(), 'Electron fixture did not focus');
  const buffer = window.getNativeWindowHandle();
  const handle = buffer.length >= 8 ? buffer.readBigUInt64LE().toString() : String(buffer.readUInt32LE());
  await desktop('focus', marker, handle);
  results.focused = true;
  results.status = 'passed';
}
main().catch(error => {
  results.status = 'failed'; results.blocker = error.stack;
  console.error(error);
  console.error('Native acceptance NOT proven. Hosted Windows may have a noninteractive/service desktop, disabled notifications, or missing unpackaged toast identity. Inspect UIA and screenshots; do not treat show as delivery.');
}).finally(() => {
  toast?.close();
  if (window && !window.isDestroyed()) window.destroy();
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
  app.exit(results.status === 'passed' ? 0 : 1);
});
