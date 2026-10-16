import { app, BrowserWindow, dialog, ipcMain, shell, systemPreferences } from 'electron';
import { type EngineStatus, IpcChannels, IpcEvents } from '@nekko-agent/shared';
import { initUpdater, checkForUpdates, downloadUpdate, quitAndInstall } from './update.js';
import type { EngineProcess } from './engine-process.js';
import type { ShellBridge, ShellDialog } from './agentBrowser.js';
import { ENGINE_ENDPOINT_CHANNEL, PICK_FOLDER_CHANNEL, SERVICE_CONTROL_CHANNEL, type ServiceAction } from '../engineChannels.js';

/** The window a dialog belongs to: the focused app window, else any. */
function appWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.isVisible()) ?? BrowserWindow.getAllWindows()[0];
}

/**
 * The native folder picker: the chosen folder, or null when cancelled. Drawn
 * here only without the engine daemon (`mode: 'backend'`) or where the daemon
 * asks main to draw it (macOS); otherwise nekkod draws it itself.
 */
export async function pickFolderDialog(): Promise<string | null> {
  const win = appWindow();
  const res = win
    ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    : await dialog.showOpenDialog({ properties: ['openDirectory'] });
  return res.canceled || !res.filePaths[0] ? null : res.filePaths[0];
}

/** A dialog the daemon asked main to draw, answered as nekkod's own dialogs answer. */
async function drawDialog(kind: ShellDialog, o: Record<string, any>): Promise<unknown> {
  const win = appWindow();
  const show = <T>(f: (w?: BrowserWindow) => Promise<T>) => f(win);
  const file = { title: o.title, defaultPath: o.defaultPath, filters: o.filters };
  if (kind === 'pickFolder') {
    const r = await show((w) => w ? dialog.showOpenDialog(w, { ...file, properties: ['openDirectory', 'createDirectory'] }) : dialog.showOpenDialog({ ...file, properties: ['openDirectory', 'createDirectory'] }));
    return r.canceled ? null : r.filePaths[0] ?? null;
  }
  if (kind === 'openFiles') {
    const properties: ('openFile' | 'multiSelections')[] = o.multiple === false ? ['openFile'] : ['openFile', 'multiSelections'];
    const r = await show((w) => w ? dialog.showOpenDialog(w, { ...file, properties }) : dialog.showOpenDialog({ ...file, properties }));
    return r.canceled ? [] : r.filePaths;
  }
  if (kind === 'saveFile') {
    const r = await show((w) => w ? dialog.showSaveDialog(w, file) : dialog.showSaveDialog(file));
    return r.canceled ? null : r.filePath ?? null;
  }
  const box = { message: String(o.message ?? ''), detail: o.detail, title: o.title, type: o.type, buttons: o.buttons?.length ? o.buttons : ['OK'], cancelId: o.cancelId, noLink: true };
  const r = await show((w) => w ? dialog.showMessageBox(w, box) : dialog.showMessageBox(box));
  return { response: r.response };
}

/**
 * The bridge's window-shell half (see `startAgentBrowser({ shell })`): what
 * nekkod still needs from main once it owns the native channels.
 */
export function shellBridge(quit: () => void): ShellBridge {
  return {
    nativeWindow: () => {
      const win = appWindow();
      if (!win || win.isDestroyed()) return null;
      const buf = win.getNativeWindowHandle();
      // HWND / NSView* are pointer-sized, an X11 window id 32 bits.
      const value = buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
      return value === 0n ? null : value.toString();
    },
    dialog: drawDialog,
    quitForUpdate: () => setImmediate(quit),
  };
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload);
}

/**
 * The channels main answers itself only when the engine runs without nekkod
 * (`mode: 'backend'`, a checkout with no daemon build, being deleted soon).
 * With the daemon, the preload sends them to it like every other channel.
 */
export const BACKEND_ONLY_CHANNELS = [
  IpcChannels.voicePermission,
  IpcChannels.dialogOpenFiles,
  IpcChannels.openPath,
  IpcChannels.updateCheck,
  IpcChannels.updateDownload,
  IpcChannels.updateInstall,
] as const;

/**
 * What only the Electron main process can answer: where the engine is, its
 * start and stop (the tray's service controls), and, for the no-daemon path
 * only, the native channels nekkod now serves. Window management (windows,
 * menus, the tray, the in-app browser and capture bridge) stays in main by
 * nature and has no channel here.
 */
export function registerIpc(engine: EngineProcess): void {
  ipcMain.handle(ENGINE_ENDPOINT_CHANNEL, async (event, operation = 'connection retry') => {
    const requester = `renderer ${event.sender.id} (${event.sender.getURL()})`;
    if (!engine.running) {
      console.info(`Nekko service is stopped; requested by ${requester}: ${operation}`);
      return null;
    }
    try { return await engine.endpoint(); }
    catch (error) {
      if (engine.running) throw error;
      console.info(`Nekko service is stopped; requested by ${requester}: ${operation}`);
      return null;
    }
  });
  let controlling = false;
  ipcMain.handle(SERVICE_CONTROL_CHANNEL, async (_event, action: ServiceAction) => {
    if (!['status', 'start', 'stop', 'restart', 'model-start', 'model-stop'].includes(action)) throw new Error('Unknown service action');
    if (action !== 'status') {
      if (controlling) throw new Error('A service action is already in progress');
      controlling = true;
      try {
        if (action === 'stop' || action === 'restart') await engine.stop();
        if (action === 'start' || action === 'restart') { engine.start(); await engine.endpoint(); }
        if (action === 'model-start' || action === 'model-stop') {
          if (!engine.running) throw new Error('Start the agent server first');
          const result = action === 'model-start'
            ? await engine.call<{ error?: string }>(IpcChannels.runtimeStart, 'nekko-engine')
            : await engine.call<{ ok: boolean; message?: string }>(IpcChannels.runtimeStop, 'nekko-engine', true);
          if ('error' in result && result.error) throw new Error(result.error);
          if ('ok' in result && !result.ok) throw new Error(result.message || 'Could not stop model server');
        }
      } finally { controlling = false; }
    }
    const model = engine.running ? await engine.call<EngineStatus>(IpcChannels.engineStatus) : null;
    return { agentRunning: engine.running, modelRunning: model?.running ?? false,
      modelAvailable: Boolean(model?.install.binPath || model?.diffusionInstall?.binPath || model?.mlxInstall?.binPath) };
  });

  // ---- The no-daemon path only (`mode: 'backend'`). ----

  ipcMain.handle(IpcChannels.voicePermission, async (_event, action = 'status') => {
    if (!['status', 'request', 'settings'].includes(action)) throw new Error('Unknown microphone permission action');
    if (action === 'request' && process.platform === 'darwin') await systemPreferences.askForMediaAccess('microphone');
    if (action === 'settings') {
      if (process.platform === 'win32') await shell.openExternal('ms-settings:privacy-microphone');
      else if (process.platform === 'darwin') await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
    }
    return { platform: process.platform, status: process.platform === 'win32' || process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('microphone') : 'unknown' };
  });

  // Native folder picker. The preload adds the chosen path through the engine.
  ipcMain.handle(PICK_FOLDER_CHANNEL, () => pickFolderDialog());

  // Native multi-file picker → absolute paths.
  ipcMain.handle(IpcChannels.dialogOpenFiles, async () => {
    const win = appWindow();
    const res = await dialog.showOpenDialog(win!, { properties: ['openFile', 'multiSelections'] });
    return res.canceled ? [] : res.filePaths;
  });

  // Reveal/open a path or URL with the OS.
  ipcMain.handle(IpcChannels.openPath, async (_e, target: string) => {
    if (/^https?:\/\//i.test(target)) await shell.openExternal(target);
    else await shell.openPath(target);
  });

  // App info (real Electron version + desktop edition), when the TS backend runs alone.
  ipcMain.handle(IpcChannels.appInfo, () => ({
    version: app.getVersion(),
    platform: process.platform,
    edition: 'desktop' as const,
  }));

  // Auto-update controls (electron-updater), without the daemon.
  initUpdater((u) => broadcast(IpcEvents.updateEvent, u));
  ipcMain.handle(IpcChannels.updateCheck, () => checkForUpdates());
  ipcMain.handle(IpcChannels.updateDownload, () => downloadUpdate());
  ipcMain.handle(IpcChannels.updateInstall, () => quitAndInstall());
}
