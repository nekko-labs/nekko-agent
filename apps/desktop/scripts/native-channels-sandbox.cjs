// Runs inside Electron, launched by native-channels-integration.cjs: the real
// built app (out/main/index.js) with isolated data, home and app-data folders,
// the worktree's nekkod, and a loopback update feed. Drives the real renderer
// through its own `window.nekko` API (no remote debugging port): the daemon's
// folder picker and message box over the app window, opening a path, and the
// updater from check to install with a stand-in installer. Writes report.json.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const out = process.env.NEKKO_NATIVE_OUT;
if (!out) throw Error('Use native-channels-integration.cjs');
const report = { steps: [], errors: [] };
const write = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (name, data) => { report.steps.push({ name, at: Date.now(), ...data }); write(); console.log('STEP', name, JSON.stringify(data ?? {})); };
// The integration script (outside) captures the screen when it sees these files.
const signal = async (name, spec, waitMs = 15000) => {
  fs.writeFileSync(path.join(out, `want-${name}`), JSON.stringify(spec));
  const done = path.join(out, `done-${name}`);
  const end = Date.now() + waitMs;
  while (!fs.existsSync(done) && Date.now() < end) await sleep(100);
};

app.setAsDefaultProtocolClient = () => false;
require(path.join(process.env.NEKKO_APP_DIR, 'out', 'main', 'index.js'));

// Window probes, as a script file run asynchronously (never block main: it
// answers the daemon's bridge while a dialog is up).
const PROBE = String.raw`param([string]$Mode, [long]$Hwnd)
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public class W {
  public delegate bool P(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(P p, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint c);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public static List<string> Dialogs() {
    var r = new List<string>();
    EnumWindows((h, l) => {
      var c = new StringBuilder(64); GetClassName(h, c, 64);
      if (c.ToString() == "#32770" && IsWindowVisible(h)) {
        var t = new StringBuilder(256); GetWindowText(h, t, 256); uint p; GetWindowThreadProcessId(h, out p);
        r.Add(h.ToInt64() + "|" + GetWindow(h, 4).ToInt64() + "|" + p + "|" + t);
      }
      return true; }, IntPtr.Zero);
    return r;
  }
}
'@
if ($Mode -eq 'close') { [void][W]::SendMessage([IntPtr]$Hwnd, 0x10, [IntPtr]::Zero, [IntPtr]::Zero); exit 0 }
$d = @([W]::Dialogs() | ForEach-Object { $x = $_.Split('|', 4); [pscustomobject]@{ hwnd = [long]$x[0]; owner = [long]$x[1]; pid = [int]$x[2]; title = $x[3] } })
[pscustomobject]@{ dialogs = $d; appEnabled = [W]::IsWindowEnabled([IntPtr]$Hwnd) } | ConvertTo-Json -Depth 4 -Compress
`;
const probeFile = path.join(out, 'probe.ps1');
fs.writeFileSync(probeFile, PROBE);
const runProbe = (mode, hwnd) => new Promise((resolve) => {
  cp.execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', probeFile, '-Mode', mode, '-Hwnd', String(hwnd)], { windowsHide: true }, (err, stdout, stderr) => {
    if (err) return resolve({ error: String(stderr || err) });
    try { resolve(stdout.trim() ? JSON.parse(stdout) : {}); } catch (e) { resolve({ error: String(e), stdout }); }
  });
});
const winOwner = (hwnd) => runProbe('list', hwnd);
const closeDialog = (dialogHwnd) => runProbe('close', dialogHwnd);

/** The engine's address and token, as the preload asks main for them. */
async function main_endpoint() {
  const { ipcMain } = require('electron');
  // Call the registered handler directly (the same one the preload invokes).
  const handler = ipcMain._invokeHandlers?.get?.('engine:endpoint');
  if (handler) return handler({ sender: { id: 0, getURL: () => 'sandbox' } }, 'sandbox');
  throw Error('engine:endpoint handler not found');
}

async function main() {
  await app.whenReady();
  let win;
  for (let i = 0; i < 300 && !win; i++) {
    win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes('renderer'));
    if (!win) await sleep(100);
  }
  if (!win) throw Error('The app window did not open');
  for (let i = 0; i < 300; i++) {
    const ready = await win.webContents.executeJavaScript('!!window.nekko && document.readyState === "complete" && !!document.querySelector("nav")').catch(() => false);
    if (ready) break;
    await sleep(200);
  }
  // Centred on the primary display: a message box is centred on the monitor,
  // so it then falls inside the app window and the capture holds nothing else.
  const area = require('electron').screen.getPrimaryDisplay().workArea;
  win.setBounds({ x: Math.round(area.x + (area.width - 1200) / 2), y: Math.round(area.y + (area.height - 800) / 2), width: 1200, height: 800 });
  win.show(); win.focus();
  await sleep(1500);
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const hwnd = win.getNativeWindowHandle().readBigUInt64LE(0).toString();
  step('app window', { hwnd, title: win.getTitle() });
  const info = await js('window.nekko.getAppInfo()');
  step('app:info from the daemon', info);

  // 1. The folder picker: drawn by nekkod, owned by the app window.
  // `void`: executeJavaScript would otherwise wait for the picker to close.
  await js('void (window.__pick = window.nekko.pickFolder().then(p => ({ path: p }), e => ({ error: String(e) })))');
  let found;
  for (let i = 0; i < 50; i++) {
    found = await winOwner(hwnd);
    if (found.dialogs?.length) break;
    await sleep(200);
  }
  const picker = (found.dialogs || [])[0];
  step('folder picker shown', { dialog: picker, ownedByAppWindow: picker ? String(picker.owner) === hwnd : false, appWindowDisabledWhileOpen: found.appEnabled === false, dialogPid: picker?.pid });
  if (picker) await closeDialog(picker.hwnd);
  step('folder picker cancelled', await js('window.__pick'));

  // The same picker again for the screenshot, opened in an empty sandbox
  // folder (dialog:pickFolder with a defaultPath) so it shows no real files.
  const endpoint = await main_endpoint();
  const call = (channel, args) => fetch(`${endpoint.url}/api/${channel}`, { method: 'POST', headers: { Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ args }) }).then((r) => r.json());
  const empty = path.join(process.env.NEKKO_DATA_DIR, 'Projects');
  fs.mkdirSync(path.join(empty, 'nekko-sandbox-project'), { recursive: true });
  const pick2 = call('dialog:pickFolder', [{ title: 'Add a project folder', defaultPath: empty }]);
  let shown;
  for (let i = 0; i < 50; i++) {
    shown = await winOwner(hwnd);
    if (shown.dialogs?.length) break;
    await sleep(200);
  }
  const picker2 = (shown.dialogs || [])[0];
  step('folder picker (sandbox folder) shown', { dialog: picker2, ownedByAppWindow: picker2 ? String(picker2.owner) === hwnd : false });
  await sleep(800);
  if (picker2) await signal('picker', { hwnds: [hwnd, picker2.hwnd], maskNavOf: picker2.hwnd });
  if (picker2) await closeDialog(picker2.hwnd);
  step('folder picker (sandbox folder) cancelled', { answer: await pick2 });

  // 2. A message box drawn by the daemon (dialog:message), over the same window.
  // No NekkoApi method calls it yet, so the sandbox asks the daemon directly
  // with the engine's own endpoint and token (main's engine:endpoint).
  const msg = fetch(`${endpoint.url}/api/dialog:message`, { method: 'POST', headers: { Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ args: [{ title: 'Nekko Agent', message: 'Move Nekko Agent data?', detail: 'Drawn by nekkod, owned by the app window.', buttons: ['Cancel', 'Move'], cancelId: 0 }] }) }).then((r) => r.json());
  let boxFound;
  for (let i = 0; i < 50; i++) {
    boxFound = await winOwner(hwnd);
    if (boxFound.dialogs?.length) break;
    await sleep(200);
  }
  const box = (boxFound.dialogs || [])[0];
  step('message box shown', { dialog: box, ownedByAppWindow: box ? String(box.owner) === hwnd : false, appWindowDisabledWhileOpen: boxFound.appEnabled === false });
  if (box) await signal('message', { hwnds: [hwnd, box.hwnd] });
  if (box) await closeDialog(box.hwnd);
  step('message box dismissed', { answer: await msg });

  // 3. Opening a path: a folder in the sandbox data dir, through the daemon
  // (Explorer opens it; a folder needs no file association).
  const target = path.join(process.env.NEKKO_DATA_DIR, 'opened-by-nekkod');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'README.txt'), 'Opened by nekkod through shell:openPath.\n');
  const opened = await js(`window.nekko.openPath(${JSON.stringify(target)}).then(() => 'ok', e => String(e))`);
  step('shell:openPath', { target, result: opened });
  // The Explorer window it opened, found by its folder (never any other window).
  const explorer = async (verb) => new Promise((resolve) => cp.execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(New-Object -ComObject Shell.Application).Windows() | Where-Object { $_.LocationURL -like '*opened-by-nekkod*' } | ForEach-Object { ${verb} }`], { windowsHide: true }, (_e, so) => resolve(String(so || '').trim())));
  let explorerHwnd = '';
  for (let i = 0; i < 40 && !explorerHwnd; i++) { await sleep(250); explorerHwnd = (await explorer('$_.HWND')).split(/\s+/)[0]; }
  step('Explorer opened the folder', { hwnd: explorerHwnd || null, location: await explorer('$_.LocationName') });
  // Over the app window (Explorer opens wherever it last was), so the capture
  // holds only it; the app's own window is left where it is.
  const b = win.getBounds();
  const scale = require('electron').screen.getPrimaryDisplay().scaleFactor;
  await explorer(`$_.Left = ${Math.round(b.x * scale)}; $_.Top = ${Math.round(b.y * scale)}; $_.Width = ${Math.round(b.width * scale)}; $_.Height = ${Math.round(b.height * scale)}`);
  await sleep(3000);
  if (explorerHwnd) await signal('openpath', { hwnds: [explorerHwnd], maskNavOf: explorerHwnd, maskFrac: 0.2 });
  await explorer('$_.Quit()');

  // 4. The updater, end to end against the loopback feed.
  const states = [];
  await js('window.__states = []; void window.nekko.onUpdateEvent(u => window.__states.push(u.state))');
  const checked = await js('window.nekko.checkForUpdates()');
  step('update:check', checked);
  const downloaded = await js('window.nekko.downloadUpdate()');
  step('update:download', downloaded);
  states.push(...await js('window.__states'));
  step('update:event states seen by the renderer', { states });
  // The title bar's update control shows the downloaded update.
  await sleep(1000);
  step('title bar update control', { text: await js(`[...document.querySelectorAll('button')].map(b => b.innerText.trim()).find(t => /ready to install|restart|update/i.test(t)) ?? null`) });
  await signal('update-ready', { hwnds: [hwnd] });
  // Install: the stand-in installer runs with the silent-update arguments and main quits.
  step('update:install requested', {});
  await js('window.nekko.quitAndInstall().catch(e => String(e))');
}

main().catch((e) => { report.errors.push(String(e && e.stack || e)); write(); app.exit(1); });
app.on('will-quit', () => { step('app quitting', {}); });
