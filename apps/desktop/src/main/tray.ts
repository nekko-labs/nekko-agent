import { Menu, Tray, nativeImage, type MenuItemConstructorOptions } from 'electron';
import { IpcChannels, type EngineStatus } from '@nekko-agent/shared';
import type { EngineProcess } from './engine-process.js';

export function createDesktopTray(options: {
  iconPath: string;
  engine: EngineProcess;
  showUi: () => void;
  newChat: () => void;
  /** Opens the Send feedback sheet (the only way there on Windows and Linux without the rail). */
  feedback: () => void;
  serviceStarted: () => void;
  quit: () => void;
  onError: (message: string) => void;
}) {
  const { engine } = options;
  const tray = new Tray(nativeImage.createFromPath(options.iconPath).resize({ width: 20, height: 20 }));
  tray.setToolTip('Nekko Agent');
  let busy = false;
  let disposed = false;
  let modelStatus: EngineStatus | null = null;
  const run = (action: () => Promise<void>) => {
    if (busy || disposed) return;
    busy = true;
    render();
    void action().catch(e => options.onError(e instanceof Error ? e.message : 'The tray action failed.')).finally(() => {
      busy = false;
      void refresh();
    });
  };
  const startService = async () => {
    engine.start();
    await engine.endpoint();
    options.serviceStarted();
  };
  const render = () => {
    if (disposed) return;
    const entries: MenuItemConstructorOptions[] = [
      { label: 'Open a new chat', enabled: !busy, click: () => run(async () => { if (!engine.running) await startService(); options.newChat(); }) },
      { label: 'Open Nekko Agent', click: options.showUi },
      { type: 'separator' },
      { label: engine.running ? 'Stop Nekko service' : 'Start Nekko service', enabled: !busy, click: () => run(async () => { if (engine.running) { await engine.stop(); modelStatus = null; } else await startService(); }) },
      { label: 'Restart Nekko service', enabled: !busy, click: () => run(async () => { await engine.stop(); modelStatus = null; await startService(); }) },
      { type: 'separator' },
      { label: modelStatus?.running ? 'Stop model server' : 'Start model server', enabled: !busy && engine.running && Boolean(modelStatus?.install.binPath || modelStatus?.diffusionInstall?.binPath || modelStatus?.mlxInstall?.binPath), click: () => run(async () => {
        const status = await engine.call<EngineStatus>(IpcChannels.engineStatus);
        if (status.running) {
          const res = await engine.call<{ ok: boolean; message?: string }>(IpcChannels.runtimeStop, 'nekko-engine', true);
          if (!res.ok) throw new Error(res.message || 'Could not stop the model server.');
        } else {
          const res = await engine.call<{ error?: string }>(IpcChannels.runtimeStart, 'nekko-engine');
          if (res.error) throw new Error(res.error);
        }
      }) },
      { type: 'separator' },
      { label: 'Send feedback…', click: options.feedback },
      { label: 'Quit Nekko Agent', enabled: !busy, click: options.quit },
    ];
    tray.setContextMenu(Menu.buildFromTemplate(entries));
  };
  let refreshing = false;
  const refresh = async () => {
    if (refreshing || disposed) return;
    refreshing = true;
    try { modelStatus = engine.running ? await engine.call<EngineStatus>(IpcChannels.engineStatus) : null; }
    catch { modelStatus = null; }
    finally { refreshing = false; render(); }
  };
  tray.on('click', options.showUi);
  tray.on('double-click', options.showUi);
  const timer = setInterval(() => { void refresh(); }, 6000);
  render();
  void refresh();
  return { tray, dispose: () => { disposed = true; clearInterval(timer); tray.destroy(); } };
}
