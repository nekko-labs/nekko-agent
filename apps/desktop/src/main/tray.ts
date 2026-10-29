import { Menu, Tray, nativeImage, type MenuItemConstructorOptions, type NativeImage } from 'electron';
import { IpcChannels, runnerActivity, type EngineStatus, type RunnerView } from '@nekko-agent/shared';
import type { EngineProcess } from './engine-process.js';
import { RUNNER_DOT_BGRA, paintDot } from './trayDot.js';

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
  const plain = nativeImage.createFromPath(options.iconPath).resize({ width: 20, height: 20 });
  let dotted: NativeImage | null = null;
  const tray = new Tray(plain);
  tray.setToolTip('Nekko Agent');
  let runners = { vms: 0, awake: false };
  let showsDot = false;
  let busy = false;
  let disposed = false;
  /** What the menu shows of the model server: whether it runs, and whether any runtime is installed. */
  let modelStatus: { running: boolean; installed: boolean } | null = null;
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
      ...(runners.vms > 0 ? [{ label: `CI runners: ${runners.vms} ${runners.vms === 1 ? 'VM' : 'VMs'} running`, enabled: false }] : []),
      ...(runners.awake ? [{ label: 'Keeping this Mac awake for CI', enabled: false }] : []),
      { type: 'separator' },
      { label: modelStatus?.running ? 'Stop model server' : 'Start model server', enabled: !busy && engine.running && Boolean(modelStatus?.installed), click: () => run(async () => {
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
    const dot = runners.vms > 0 || runners.awake;
    if (dot !== showsDot) {
      showsDot = dot;
      dotted ??= nativeImage.createFromBitmap(paintDot(plain.toBitmap(), 20, 20, RUNNER_DOT_BGRA), { width: 20, height: 20 });
      tray.setImage(dot ? dotted : plain);
      tray.setToolTip(dot ? 'Nekko Agent · CI runner active' : 'Nekko Agent');
    }
  };
  const readModelStatus = async () => {
    const runtimes = process.platform === 'darwin' && process.arch === 'arm64' ? ['llama', 'diffusion', 'mlx'] : ['llama', 'diffusion'];
    const [running, ...bins] = await Promise.all([
      engine.call<boolean>('engine:running'),
      ...runtimes.map(r => engine.call<string | null>('engine:installedBin', r)),
    ]);
    return { running: running === true, installed: bins.some(Boolean) };
  };
  let refreshing = false;
  const refresh = async () => {
    if (refreshing || disposed) return;
    refreshing = true;
    // Not `engine:status`: that probes the GPU (an `nvidia-smi` run) and
    // searches for runtimes each time, which this poll did every 6 s with no
    // window open. These two are cheap and answer the menu's questions.
    try { modelStatus = engine.running ? await readModelStatus() : null; }
    catch { modelStatus = null; }
    try {
      // The daemon serves no runners off macOS or when older: a rejection means none.
      runners = runnerActivity(engine.running ? await engine.call<RunnerView[]>(IpcChannels.runnerList) : []);
    } catch { runners = { vms: 0, awake: false }; }
    finally { refreshing = false; render(); }
  };
  tray.on('click', options.showUi);
  tray.on('double-click', options.showUi);
  const timer = setInterval(() => { void refresh(); }, 6000);
  render();
  void refresh();
  return { tray, dispose: () => { disposed = true; clearInterval(timer); tray.destroy(); } };
}
