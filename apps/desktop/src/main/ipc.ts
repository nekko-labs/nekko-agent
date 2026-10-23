import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { type EngineStatus, IpcChannels } from '@nekko-agent/shared';
import type { EngineProcess } from './engine-process.js';
import type { ShellBridge, ShellDialog } from './agentBrowser.js';
import { ENGINE_ENDPOINT_CHANNEL, SERVICE_CONTROL_CHANNEL, type ServiceAction } from '../engineChannels.js';

/** The window a dialog belongs to: the focused app window, else any. */
function appWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.isVisible()) ?? BrowserWindow.getAllWindows()[0];
}

/**
 * The native folder picker: the chosen folder, or null when cancelled. Drawn
 * here only where the daemon asks main to draw it (macOS, through the browser
 * bridge); otherwise nekkod draws it itself.
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

/**
 * What only the Electron main process can answer: where the engine is, and
 * its start and stop (the tray's service controls). Window management
 * (windows, menus, the tray, the in-app browser and capture bridge) stays in
 * main by nature and has no channel here; every other channel is nekkod's.
 */
/**
 * Whether an IPC call comes from one of the app's own windows, from its top
 * frame: never an embedded frame or any other web contents (the in-app
 * browser's pages), which must not learn the engine's token or stop it.
 */
export function fromAppMainFrame(event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>, isAppWindow: (sender: WebContents) => boolean): boolean {
  const main = event.sender?.mainFrame;
  return isAppWindow(event.sender) && main != null && event.senderFrame === main;
}

export function registerIpc(engine: EngineProcess, isAppWindow: (sender: WebContents) => boolean): void {
  ipcMain.handle(ENGINE_ENDPOINT_CHANNEL, async (event, operation = 'connection retry') => {
    if (!fromAppMainFrame(event, isAppWindow)) throw new Error('The engine endpoint is only given to the application window.');
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
  ipcMain.handle(SERVICE_CONTROL_CHANNEL, async (event, action: ServiceAction) => {
    if (!fromAppMainFrame(event, isAppWindow)) throw new Error('Service controls are only available to the application window.');
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
}
