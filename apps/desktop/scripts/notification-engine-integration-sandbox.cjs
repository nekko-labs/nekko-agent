// Runs under Electron, never starts the normal app or native OS notifications.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const out = process.env.NEKKO_NOTIFICATION_INTEGRATION_OUT;
if (!out) throw Error('Use notification-engine-integration.cjs');
const isolated = path.join(out, 'isolated');
app.setPath('userData', path.join(isolated, 'profile'));
app.setPath('sessionData', path.join(isolated, 'profile'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const results = { checks: [], events: [], notifications: [], links: [] };
const check = (name, fn) => { fn(); results.checks.push(name); console.log('PASS:', name); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 10000) {
  const end = Date.now() + timeout;
  while (!fn()) { if (Date.now() > end) throw Error('Timed out: ' + label); await sleep(25); }
}
let engine, window, witness, stop, poster;
async function main() {
  await app.whenReady();
  const api = require(path.join(out, 'integration-api.cjs'));
  const { IpcChannels: C, IpcEvents: E } = api;
  engine = new api.EngineProcess({ dataDir: path.join(isolated, 'data'), mainDir: out, origins: ['null'], app: { isPackaged: false, appPath: path.resolve(__dirname, '..'), userData: path.join(isolated, 'profile'), version: '0.0.0-integration' } });
  engine.start();
  const endpoint = await engine.endpoint();
  results.mode = endpoint.mode;
  check('Forced real TS backend using nonexistent NEKKOD_PATH', () => assert.equal(endpoint.mode, 'backend'));
  const settings = await engine.call(C.settingsGet);
  check('Backend reads isolated settings with optional services disabled', () => {
    assert.equal(settings.apiServer.enabled, false);
    assert.equal(settings.updates.modelLists, false);
  });
  window = new BrowserWindow({ show: false, focusable: false, x: -32000, y: -32000, width: 500, height: 300, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
  await window.loadURL('data:text/html,<title>Notification integration isolated renderer</title><p>Hidden integration fixture</p>');
  check('Isolated renderer hidden, nonfocusable, and responsive', () => { assert.equal(window.isVisible(), false); assert.equal(window.isFocusable(), false); });
  assert.equal(await window.webContents.executeJavaScript('document.title'), 'Notification integration isolated renderer');
  witness = new WebSocket(`${endpoint.url.replace(/^http/, 'ws')}/api/ws?token=${encodeURIComponent(endpoint.token)}`);
  witness.onmessage = ({ data }) => { const frame = JSON.parse(String(data)); if (frame.channel === E.agentEvent) results.events.push(frame.payload); };
  await until(() => witness.readyState === WebSocket.OPEN, 'independent real websocket witness');
  // Prove backend lifetime independently of the parent's pending adapter API.
  const baseline = await engine.call(C.sessionCreate);
  await engine.call(C.chatSend, { sessionId: baseline.id, providerId: 'intentionally-unconfigured-integration-provider', modelId: 'unused', text: 'Hidden backend baseline' });
  await until(() => results.events.some(event => event.sessionId === baseline.id && event.type === 'error'), 'hidden backend baseline witness');
  check('Real backend emits legitimate chatSend error with hidden renderer', () => assert.equal(engine.running, true));
  window.close();
  await until(() => window.isDestroyed(), 'baseline renderer close');
  const noRenderer = await engine.call(C.sessionCreate);
  await engine.call(C.chatSend, { sessionId: noRenderer.id, providerId: 'intentionally-unconfigured-integration-provider', modelId: 'unused', text: 'Closed backend baseline' });
  await until(() => results.events.some(event => event.sessionId === noRenderer.id && event.type === 'error'), 'closed backend baseline witness');
  check('Real backend HTTP and websocket survive zero renderer windows', () => { assert.equal(engine.running, true); assert.equal(BrowserWindow.getAllWindows().length, 0); });
  assert.equal(typeof api.createNativeNotificationPoster, 'function', 'Parent createNativeNotificationPoster API must be implemented');
  window = new BrowserWindow({ show: false, focusable: false, x: -32000, y: -32000, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
  await window.loadURL('data:text/html,<title>Hidden adapter verification</title>');
  const instances = [];
  class InjectedNotification extends EventEmitter {
    constructor(options) { super(); this.options = options; this.shown = 0; this.closed = 0; instances.push(this); }
    show() { this.shown++; results.notifications.push(this.options); }
    close() { this.closed++; this.emit('close'); }
  }
  poster = api.createNativeNotificationPoster({ isSupported: () => true, create: options => new InjectedNotification(options) }, link => results.links.push(link));
  let context = { windowHidden: true, visibleSessionId: null };
  const sockets = [];
  const makeSocket = url => { const socket = new WebSocket(url); sockets.push(socket); return socket; };
  stop = api.startMainNotifications(engine, poster.post, makeSocket, () => context);
  await until(() => sockets.some(socket => socket.readyState === WebSocket.OPEN), 'main real websocket connection');
  async function actualError(label) {
    const session = await engine.call(C.sessionCreate);
    await engine.call(C.sessionSetOptions, session.id, { title: label });
    await engine.call(C.chatSend, { sessionId: session.id, providerId: 'intentionally-unconfigured-integration-provider', modelId: 'unused', text: 'Verify legitimate provider admission error.' });
    await until(() => results.events.some(event => event.sessionId === session.id && event.type === 'error'), 'real error witness: ' + label);
    return session;
  }
  const hidden = await actualError('Hidden renderer survival');
  await until(() => instances.length === 1, 'hidden renderer notification');
  check('Real chatSend error delivered while renderer hidden', () => { assert.equal(instances[0].shown, 1); assert.match(instances[0].options.title, /failed/i); assert.match(instances[0].options.body, /Hidden renderer survival/); });
  instances[0].emit('click'); instances[0].emit('click');
  check('Injected native click delivers session deep link once without OS toast', () => { assert.deepEqual(results.links, [api.notificationLink(hidden.id)]); });
  window.close();
  await until(() => window.isDestroyed(), 'renderer close');
  const closed = await actualError('Closed renderer survival');
  await until(() => instances.length === 2, 'notification with no renderer');
  check('Engine HTTP, websocket, and notification survive closed renderer', () => { assert.equal(BrowserWindow.getAllWindows().length, 0); assert.equal(engine.running, true); assert.equal(instances[1].shown, 1); assert.match(instances[1].options.body, /Closed renderer survival/); });
  const disabled = await engine.call(C.settingsUpdate, { desktopNotifications: false });
  assert.equal(disabled.desktopNotifications, false);
  const beforeOptOut = instances.length;
  const optedOut = await actualError('Opt-out real event witness');
  await sleep(750);
  check('Engine settings opt-out suppresses posting despite witnessed real event', () => { assert.equal(instances.length, beforeOptOut); assert.ok(results.events.some(event => event.sessionId === optedOut.id && event.type === 'error')); });
  await engine.call(C.settingsUpdate, { desktopNotifications: true });
  await actualError('Re-enabled notifications');
  await until(() => instances.length === 3, 'reenabled notification');
  check('Engine settings re-enable resumes real-event notifications', () => assert.equal(instances[2].shown, 1));
  // No renderer is made visible: inject foreground context to exercise policy safely.
  const foreground = await engine.call(C.sessionCreate);
  context = { windowHidden: false, visibleSessionId: foreground.id };
  await engine.call(C.chatSend, { sessionId: foreground.id, providerId: 'intentionally-unconfigured-integration-provider', modelId: 'unused', text: 'Foreground policy test' });
  await until(() => results.events.some(event => event.sessionId === foreground.id && event.type === 'error'), 'foreground real event witness');
  await sleep(750);
  check('Fourth context provider suppresses visible-session real event', () => assert.equal(instances.length, 3));
  context = { windowHidden: true, visibleSessionId: null };
  const other = await actualError('Final disposable notification');
  await until(() => instances.length === 4, 'final live notice');
  instances[1].emit('close');
  instances[2].emit('failed', Error('Injected platform failure'));
  poster.dispose();
  check('Adapter disposal closes retained live notifications', () => assert.ok(instances[3].closed >= 1));
  const linkCount = results.links.length;
  instances[3].emit('click');
  check('Disposed native notification does not deliver stale click', () => assert.equal(results.links.length, linkCount));
  stop(); stop = undefined;
  await until(() => sockets.every(socket => socket.readyState === WebSocket.CLOSED), 'main websocket disposal');
  const count = instances.length;
  await actualError('After subscription disposal');
  await sleep(500);
  check('Subscription disposal closes socket and prevents further posting', () => assert.equal(instances.length, count));
  results.status = 'passed';
}
main().catch(error => { results.status = 'failed'; results.error = error.stack; console.error(error); process.exitCode = 1; }).finally(async () => {
  try {
    stop?.(); poster?.dispose(); witness?.close();
    if (window && !window.isDestroyed()) window.destroy();
    if (engine) await engine.stop();
  } catch (error) { results.cleanupError = error.stack; results.status = 'failed'; process.exitCode = 1; }
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
  app.exit(process.exitCode || 0);
});
