if (process.platform !== 'win32' || process.env.NEKKO_LOCAL_NOTIFICATION_OPT_IN !== 'manual-single-toast') throw Error('Use the explicitly opted-in local launcher');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_LOCAL_NOTIFICATION_OUT;
const isolated = process.env.NEKKO_LOCAL_NOTIFICATION_PROFILE;
if (!out || !isolated || path.dirname(isolated) !== out || !path.basename(isolated).startsWith('isolated-')) throw Error('Fresh isolated profile required');
const { app, BrowserWindow, Notification, session } = require('electron');
const { createNativeNotificationPoster } = require(path.join(isolated, 'adapter.cjs'));
app.setPath('userData', path.join(isolated, 'profile'));
app.setPath('sessionData', path.join(isolated, 'profile'));
app.setPath('logs', path.join(isolated, 'temp'));
app.disableHardwareAcceleration();
app.setAppUserModelId('dev.nekkolabs.nekkoagent.notificationlocaltest');
app.on('window-all-closed', () => {});
const title = 'Nekko notification test (isolated)';
const results = { status: 'waiting', pid: process.pid, title, events: [], clicked: false, rendererCaptured: false, nativeWindowEvidence: 'Not captured by this fixture', scope: 'Single local manual-click fixture using production adapter; not installed-app identity, engine routing, OS sleep, or CI acceptance' };
let window, poster, done = false, deadline;
function save() { fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2)); }
function event(name, detail = {}) { results.events.push({ event: name, at: new Date().toISOString(), ...detail }); save(); console.log(JSON.stringify(results.events.at(-1))); }
function finish(status, blocker) {
  if (done) return;
  done = true; clearTimeout(deadline); results.status = status;
  if (blocker) results.blocker = blocker;
  poster?.dispose();
  if (window && !window.isDestroyed()) window.destroy();
  save(); app.exit(status === 'clicked' ? 0 : 1);
}
async function main() {
  await app.whenReady();
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('data:') }));
  results.supported = Notification.isSupported(); save();
  if (!results.supported) return finish('unsupported', 'Electron Notification unsupported; no settings changed');
  window = new BrowserWindow({ title, show: false, focusable: false, width: 680, height: 360, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><title>' + title + '</title><style>body{font:20px system-ui;background:#18212d;color:#f5f7fb;padding:32px}h1{color:#9fdfba}small{display:block;margin-top:24px}</style></head><body><h1>TEST: notification clicked</h1><p>Nekko notification test (isolated)</p><p>Your real Windows toast click reached the production native notification adapter.</p><small>No normal app, provider, network request or settings change. This window closes after 20 seconds.</small></body></html>'));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', e => e.preventDefault());
  poster = createNativeNotificationPoster({
    isSupported: () => Notification.isSupported(),
    create(options) {
      const toast = new Notification(options);
      toast.on('show', () => event('show', { note: 'Electron show event alone does not prove visible delivery' }));
      toast.on('failed', (_e, error) => { event('failed', { error: String(error) }); finish('failed', String(error)); });
      toast.on('click', () => { results.clicked = true; event('click'); });
      toast.on('close', () => event('close'));
      return toast;
    },
  }, async url => {
    if (done) return;
    clearTimeout(deadline);
    results.link = url;
    window.setFocusable(true); window.show(); window.focus();
    const handle = window.getNativeWindowHandle();
    results.windowHandle = handle.length >= 8 ? handle.readBigUInt64LE().toString() : String(handle.readUInt32LE());
    event('test-window-opened', { title, handle: results.windowHandle, electronFocused: window.isFocused() });
    deadline = setTimeout(() => finish('clicked'), 20000);
    try {
      const image = await window.webContents.capturePage();
      fs.writeFileSync(path.join(out, 'clicked-renderer.png'), image.toPNG());
      results.rendererCaptured = true; event('renderer-captured', { note: 'Renderer only; parent must capture actual native window separately' });
    } catch (error) { event('capture-failed', { error: String(error) }); }
  });
  deadline = setTimeout(() => finish('not-verified', 'No manual user click received within 90 seconds; no automatic replay'), 90000);
  event('single-toast-requested', { title, waitSeconds: 90 });
  poster.post({ sessionId: 'isolated-local-notification-test', kind: 'finished', title, body: 'TEST: click once to open the isolated TEST window. Closes automatically.' });
}
main().catch(error => finish('failed', error.stack));
