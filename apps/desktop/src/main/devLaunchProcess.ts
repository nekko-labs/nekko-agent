import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';

type DevApp = { quit(): void; on(event: 'will-quit', handler: () => void): unknown };

/** A private per-launch receipt lets the wrapper stop only its own app. */
export function registerDevLaunch(app: DevApp): void {
  watchStopFile(app);
  const file = process.env.NEKKO_DEV_PID_FILE;
  const token = process.env.NEKKO_DEV_LAUNCH_TOKEN;
  if (!file || !token) return;
  writeFileSync(file, JSON.stringify({ pid: process.pid, token, owner: process.env.NEKKO_DEV_OWNER }));
  const stop = () => app.quit();
  process.on('SIGTERM', stop);
  app.on('will-quit', () => {
    process.off('SIGTERM', stop);
    try { if (JSON.parse(readFileSync(file, 'utf8')).token === token) unlinkSync(file); } catch { /* already removed */ }
  });
}

/**
 * Tell the `npm run dev` launcher the app is up and where, so it can say so in
 * its terminal. Only under that launcher (it sets NEKKO_DEV_READY_FILE); a
 * packaged app never writes this.
 */
export function reportDevReady(info: { version: string; api: { url: string; enabled: boolean } | null; dataDir: string }): void {
  const file = process.env.NEKKO_DEV_READY_FILE;
  if (!file) return;
  try {
    writeFileSync(file, JSON.stringify({ ...info, pid: process.pid, renderer: process.env.ELECTRON_RENDERER_URL }));
  } catch { /* the banner is a nicety; never block startup on it */ }
}

export type DevActivity = { building: number; verifying: number; input: number };

type StatusSource = {
  /** `chat:activity` from the engine; rejects while it is down or restarting. */
  activity(): Promise<DevActivity>;
  /** True once the app has started quitting. */
  quitting(): boolean;
};

type DevWindow = { on(event: 'unresponsive' | 'responsive' | 'closed', handler: () => void): unknown };
type WindowEvents = { on(event: 'browser-window-created', handler: (e: unknown, win: DevWindow) => void): unknown };

/** How often the heartbeat is written. */
const STATUS_EVERY_MS = 1000;
/** An engine slower than this to answer counts as not answering for that beat. */
const ACTIVITY_WAIT_MS = 800;

/**
 * Under `npm run dev` (it sets NEKKO_DEV_STATUS_FILE), write a heartbeat once
 * a second for the status line the launcher pins under the logs: what the
 * agents are doing, whether the app is quitting, and how many windows are not
 * responding. The beat comes from this process's own timer, so it stops when
 * the main process freezes and the launcher says so; a frozen window shows as
 * not responding while the beat goes on. Returns a stop function.
 */
export function reportDevStatus(source: StatusSource, app: WindowEvents, existing: Iterable<DevWindow>): () => void {
  const file = process.env.NEKKO_DEV_STATUS_FILE;
  if (!file) return () => {};
  const frozen = new Set<DevWindow>();
  const watch = (win: DevWindow) => {
    win.on('unresponsive', () => frozen.add(win));
    win.on('responsive', () => frozen.delete(win));
    win.on('closed', () => frozen.delete(win));
  };
  for (const win of existing) watch(win);
  app.on('browser-window-created', (_e, win) => watch(win));
  let busy = false;
  const beat = async () => {
    if (busy) return;
    busy = true;
    try {
      const quitting = source.quitting();
      let activity: DevActivity | null = null;
      if (!quitting) {
        let timer: NodeJS.Timeout | undefined;
        const late = new Promise<null>((r) => { timer = setTimeout(() => r(null), ACTIVITY_WAIT_MS); });
        activity = await Promise.race([source.activity().catch(() => null), late]);
        clearTimeout(timer);
      }
      writeFileSync(file, JSON.stringify({ at: Date.now(), quitting, activity, unresponsive: frozen.size }));
    } catch { /* the status line is a nicety; never disturb the app over it */ }
    finally { busy = false; }
  };
  void beat();
  const timer = setInterval(() => void beat(), STATUS_EVERY_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * `npm run dev` asks for a clean stop by creating this file (Enter, q or
 * Ctrl+C in its terminal). A signal can't do it on Windows, where killing a
 * process is always abrupt; a normal quit stops the engine and its model
 * servers on the way out instead of orphaning them.
 */
function watchStopFile(app: DevApp): void {
  const stopFile = process.env.NEKKO_DEV_STOP_FILE;
  if (!stopFile) return;
  const poll = setInterval(() => {
    if (!existsSync(stopFile)) return;
    clearInterval(poll);
    app.quit();
  }, 250);
  poll.unref?.();
  app.on('will-quit', () => clearInterval(poll));
}
