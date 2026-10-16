import { app, BrowserWindow, dialog, ipcMain, shell, systemPreferences } from 'electron';
import { type EngineStatus, IpcChannels, IpcEvents } from '@nekko-agent/shared';
import { initUpdater, checkForUpdates, downloadUpdate, quitAndInstall } from './update.js';
import type { EngineProcess } from './engine-process.js';
import { setSessionOptionsCompat } from './session-options-compat.js';
import { ENGINE_ENDPOINT_CHANNEL, PICK_FOLDER_CHANNEL, SERVICE_CONTROL_CHANNEL, type ServiceAction } from '../engineChannels.js';

/**
 * The native folder picker: the chosen folder, or null when cancelled. The
 * renderer's picker and the engine daemon's `workspace:add` (through the
 * agent browser bridge) both open it.
 */
export async function pickFolderDialog(): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const res = win
    ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    : await dialog.showOpenDialog({ properties: ['openDirectory'] });
  return res.canceled || !res.filePaths[0] ? null : res.filePaths[0];
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload);
}

/**
 * What only the Electron main process can answer. Every other channel goes
 * from the preload straight to the engine over its socket (see
 * `preload/index.ts`), so this list is short on purpose: native dialogs, the
 * OS shell, the app's own version, the updater, and where the engine is.
 */
export function registerIpc(engine: EngineProcess, dataDir: string): void {
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
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const res = await dialog.showOpenDialog(win!, { properties: ['openFile', 'multiSelections'] });
    return res.canceled ? [] : res.filePaths;
  });

  // Reveal/open a path or URL with the OS.
  ipcMain.handle(IpcChannels.openPath, async (_e, target: string) => {
    if (/^https?:\/\//i.test(target)) await shell.openExternal(target);
    else await shell.openPath(target);
  });

  // App info (real Electron version + desktop edition).
  ipcMain.handle(IpcChannels.appInfo, () => ({
    version: app.getVersion(),
    platform: process.platform,
    edition: 'desktop' as const,
  }));

  // Session options usually belong to the engine; main only mediates this one
  // route so it can patch archivedAt for older daemons that ignore that field.
  ipcMain.handle(IpcChannels.sessionSetOptions, async (_e, sessionId: string, patch: Record<string, unknown>) =>
    setSessionOptionsCompat(engine, dataDir, sessionId, patch),
  );

  // Auto-update controls (electron-updater).
  initUpdater((u) => broadcast(IpcEvents.updateEvent, u));
  ipcMain.handle(IpcChannels.updateCheck, () => checkForUpdates());
  ipcMain.handle(IpcChannels.updateDownload, () => downloadUpdate());
  ipcMain.handle(IpcChannels.updateInstall, () => quitAndInstall());
}
