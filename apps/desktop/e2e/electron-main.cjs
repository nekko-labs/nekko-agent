// Electron main for the end-to-end suite. The window is hidden, non-focusable,
// mapped outside every monitor, and shown inactive; the profile is a scratch
// directory and every non-local request is cancelled. Never touches the user's
// app, profile or desktop.
const { app, BrowserWindow, session, screen } = require('electron');

const { NEKKO_E2E_PROFILE: profile, NEKKO_E2E_INDEX: index, NEKKO_E2E_SCENARIO: scenario } = process.env;
if (!profile || !index || !scenario) throw new Error('Launch through apps/desktop/e2e/harness.ts');
app.setPath('userData', profile);
app.setPath('sessionData', profile);

globalThis.__nekkoE2E = { tookFocus: false };

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, done) => done(false));
  const left = Math.min(...screen.getAllDisplays().map((d) => d.bounds.x));
  const win = new BrowserWindow({
    width: Number(process.env.NEKKO_E2E_WIDTH || 1200),
    height: Number(process.env.NEKKO_E2E_HEIGHT || 900),
    useContentSize: true, show: false, focusable: false, skipTaskbar: true,
    x: left - 16000, y: -16000,
    title: 'Nekko Agent end-to-end (isolated)',
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  win.on('focus', () => { globalThis.__nekkoE2E.tookFocus = true; });
  await win.loadFile(index, { query: { scenario } });
  // macOS moves shown off-screen windows onto a display. Keep its fixture hidden.
  if (process.platform !== 'darwin') win.showInactive();
});

app.on('window-all-closed', () => app.quit());
