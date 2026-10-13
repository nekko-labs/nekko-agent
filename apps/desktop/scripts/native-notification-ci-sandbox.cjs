// Real OS side effects are allowed only on an explicitly opted-in hosted CI VM.
require('./notification-integration-safety.cjs').assertDisposableWindowsCI();
const { app, Notification, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_NATIVE_CI_OUT;
const isolated = process.env.NEKKO_NATIVE_CI_PROFILE;
if (!out || !isolated) throw Error('Use native-notification-ci.cjs');
app.setPath('userData', isolated);
app.setPath('sessionData', isolated);
app.disableHardwareAcceleration();
const aumid = 'dev.nekkolabs.nekkoagent.ci.' + process.env.GITHUB_RUN_ID;
app.setAppUserModelId(aumid);
const shortcut = path.join(app.getPath('appData'), 'Microsoft/Windows/Start Menu/Programs', aumid + '.lnk');
const result = { aumid, events: [], showObserved: false, visibleToastVerified: false, clickVerified: false, focusVerified: false,
  limitations: ['Electron show is not pixel proof. Inspect raw desktop frames and OS UI Automation evidence.', 'No OS click or window activation attempted. Packaged installer identity is not covered.'] };
let notification;
app.whenReady().then(async () => {
  try {
    fs.mkdirSync(path.dirname(shortcut), { recursive: true });
    if (!shell.writeShortcutLink(shortcut, 'create', { target: process.execPath, args: JSON.stringify(__filename), appUserModelId: aumid, description: 'Disposable native notification CI fixture' })) throw Error('Test AUMID shortcut registration failed');
    result.shortcutRegistered = true;
    if (!Notification.isSupported()) throw Error('Electron reports native notifications unsupported');
    notification = new Notification({ title: process.env.NEKKO_NATIVE_CI_MARKER, body: 'Real Electron Notification.show on disposable Windows CI.', silent: true, timeoutType: 'never' });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('No real Electron show event within 20 seconds')), 20000);
      notification.once('show', () => { result.showObserved = true; result.events.push({ type: 'show', at: new Date().toISOString() }); clearTimeout(timer); resolve(); });
      notification.once('failed', (_event, error) => { result.events.push({ type: 'failed', error: String(error) }); clearTimeout(timer); reject(Error(String(error))); });
      notification.once('click', () => result.events.push({ type: 'click', at: new Date().toISOString() }));
      notification.show();
    });
    await new Promise(resolve => setTimeout(resolve, 8000));
  } catch (error) { result.error = error.stack; process.exitCode = 1; }
  finally {
    notification?.close();
    fs.rmSync(shortcut, { force: true });
    result.shortcutRemoved = !fs.existsSync(shortcut);
    fs.writeFileSync(path.join(out, 'electron-result.json'), JSON.stringify(result, null, 2));
    app.exit(process.exitCode || 0);
  }
});
