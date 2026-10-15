// Isolated native tray lifecycle fixture. No host, providers, external network or user data.
const { app, BrowserWindow, Tray, nativeImage, session } = require('electron');
const fs = require('node:fs'); const path = require('node:path');
const dir = process.env.NEKKO_TRAY_SANDBOX_DIR;
if (!dir || !dir.includes('.shots')) throw Error('Scratch profile required');
app.setPath('userData', path.join(dir, 'profile'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !d.url.startsWith('data:') }));
  const { createTrayCompanion } = require(path.join(dir, 'companion.cjs'));
  const icon = nativeImage.createFromPath(path.resolve(__dirname, '../src/renderer/public/icon-512.png')).resize({ width: 20, height: 20 });
  const tray = new Tray(icon);
  let settings = {}; const report = { updates: [], errors: [], hidden: 0, quit: 0 };
  const companion = createTrayCompanion({ tray, settings: async () => settings, update: async patch => { settings = { ...settings, ...patch }; report.updates.push(patch); }, serviceRunning: () => true, quit: () => { report.quit++; }, openSettings: () => {}, onError: error => report.errors.push(error) });
  const hide = () => report.hidden++;
  await companion.closeWindow(hide);
  const popup = BrowserWindow.getAllWindows()[0];
  fs.writeFileSync(path.join(dir, 'first-close.png'), (await popup.webContents.capturePage()).toPNG());
  console.log('READY first-close native capture');
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(report, null, 2));
  // A filesystem signal lets the parent capture the real window before proceeding.
  const deadline = Date.now() + 120000;
  while (!fs.existsSync(path.join(dir, 'continue')) && Date.now() < deadline) await sleep(200);
  if (!fs.existsSync(path.join(dir, 'continue'))) { companion.dispose(); tray.destroy(); app.exit(1); return; }
  companion.dismiss();
  await companion.closeWindow(hide);
  const farewell = BrowserWindow.getAllWindows()[0];
  fs.writeFileSync(path.join(dir, 'farewell.png'), (await farewell.webContents.capturePage()).toPNG());
  const started = Date.now();
  await sleep(2300);
  report.farewellDestroyed = farewell.isDestroyed(); report.elapsed = Date.now() - started;
  settings.trayFarewellEnabled = false;
  await companion.closeWindow(hide); report.disabledPopupCount = BrowserWindow.getAllWindows().length;
  settings.desktopCloseBehavior = 'shutdown'; await companion.closeWindow(hide);
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report)); companion.dispose(); tray.destroy(); app.exit(report.errors.length ? 1 : 0);
}).catch(e => { console.error(e); app.exit(1); });
