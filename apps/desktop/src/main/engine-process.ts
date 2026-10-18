import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

/**
 * The engine, from the window's side: start it, know where it listens, keep it
 * running, stop it on quit.
 *
 * That is `nekkod` (the Rust daemon), which in turn starts and supervises
 * the TS backend. There is no engine without it: a missing binary (a
 * development checkout that never built it, an antivirus that quarantined
 * it) or one Windows cannot load (STATUS_DLL_NOT_FOUND, see
 * `isMissingDllExit`) is reported as the reason the engine is down, and the
 * tray's Restart tries again, rather than restarting in a loop.
 *
 * The Electron main process never runs the engine itself any more: a busy
 * agent loop, a pty flood or a synchronous file write there used to stall
 * window management and every IPC reply the UI waited on.
 */

/**
 * STATUS_DLL_NOT_FOUND as Node reports a Windows exit code: the loader could
 * not find a DLL the executable imports, before any of its code ran. For
 * nekkod that has meant the Visual C++ runtime, which the installer now ships
 * beside it; restarting cannot fix it, so it is reported instead.
 */
export function isMissingDllExit(code: number | null): boolean {
  return code === 0xc0000135 || code === -1073741515;
}

export interface EngineEndpoint {
  /** `http://127.0.0.1:<port>` */
  url: string;
  token: string;
}

export interface EngineOptions {
  browserBridge?: { url: string; token: string };
  dataDir: string;
  /** Plain facts about the app the backend needs (see `backend/index.ts`). */
  app: { isPackaged: boolean; appPath: string; userData: string; version: string; resourcesPath?: string; exePath?: string; pid?: number };
  /** Page origins allowed to open sockets: the packaged `null` and, in dev, the renderer server. */
  origins: string[];
  /** Where the Electron main bundle lives (`out/main`), next to `backend.js`. */
  mainDir: string;
}

const DAEMON_READY = 'NEKKOD_READY ';
const MAX_BACKOFF_MS = 5000;

/**
 * The daemon binary: packaged resources, an explicit override, or a local cargo
 * build. In a development checkout the newest of the release, dev-daemon
 * (`npm run dev`'s profile) and debug builds wins: always preferring release
 * once ran a days-old release daemon against a fresh host, and the two
 * disagreed about what the host was asking for.
 */
export function findDaemon(opts: Pick<EngineOptions, 'app'>): string | null {
  const exe = process.platform === 'win32' ? 'nekkod.exe' : 'nekkod';
  const override = process.env.NEKKOD_PATH;
  if (override) return existsSync(override) ? override : null;
  if (opts.app.isPackaged) {
    const bin = join(opts.app.resourcesPath ?? process.resourcesPath, 'bin', exe);
    return existsSync(bin) ? bin : null;
  }
  const builds = [
    resolve(opts.app.appPath, '../../target/release', exe),
    resolve(opts.app.appPath, '../../target/dev-daemon', exe),
    resolve(opts.app.appPath, '../../target/debug', exe),
  ].flatMap((p) => {
    try {
      return [{ p, mtime: statSync(p).mtimeMs }];
    } catch {
      return [];
    }
  });
  // Newest first; on a tie, release (listed first) stays ahead.
  builds.sort((a, b) => b.mtime - a.mtime);
  return builds[0]?.p ?? null;
}

/**
 * What nekkod needs to answer the channels main used to (dialogs, the OS
 * shell, the microphone, the updater: crates/nekkod/src/native.rs).
 * `NEKKO_UPDATE_FEED_URL` points the updater at a generic feed instead of
 * `app-update.yml` (a sandbox's loopback feed), `NEKKO_UPDATE_CACHE_DIR` keeps
 * its downloads elsewhere, and `NEKKO_NATIVE_DIALOGS=bridge` has main draw
 * the dialogs.
 */
export function nativeConfig(app: EngineOptions['app'], env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  return {
    isPackaged: app.isPackaged,
    exePath: app.exePath ?? process.execPath,
    ...(app.resourcesPath ? { resourcesPath: app.resourcesPath } : {}),
    ...(env.APPIMAGE ? { appImage: env.APPIMAGE } : {}),
    appPid: app.pid ?? process.pid,
    ...(env.NEKKO_UPDATE_FEED_URL ? { updateFeedUrl: env.NEKKO_UPDATE_FEED_URL } : {}),
    ...(env.NEKKO_UPDATE_CACHE_DIR ? { updateCacheDir: env.NEKKO_UPDATE_CACHE_DIR } : {}),
    ...(env.NEKKO_NATIVE_DIALOGS ? { dialogs: env.NEKKO_NATIVE_DIALOGS } : {}),
  };
}

export class EngineProcess {
  private child: ChildProcess | null = null;
  private current: EngineEndpoint | null = null;
  private waiters: { resolve: (e: EngineEndpoint) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }[] = [];
  private stopping = false;
  private requested = false;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private stopPromise: Promise<void> | null = null;

  get running(): boolean { return this.requested && !this.stopping; }
  private backoff = 500;
  /** Why the engine cannot run, once it has failed in a way a restart will not fix. */
  private failure: string | null = null;
  private readonly token = randomBytes(24).toString('base64url');

  constructor(private readonly opts: EngineOptions) {}

  /** Resolves with the live endpoint, waiting for a (re)start if needed. */
  endpoint(): Promise<EngineEndpoint> {
    if (!this.running) return Promise.reject(new Error('Nekko service is stopped. Start it from the tray menu.'));
    if (this.current) return Promise.resolve(this.current);
    if (this.failure) return Promise.reject(new Error(this.failure));
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: setTimeout(() => {
        this.waiters = this.waiters.filter(w => w !== waiter);
        reject(new Error('Nekko service did not become ready. Try restarting it from the tray.'));
      }, 15000) };
      this.waiters.push(waiter);
    });
  }

  start(): void {
    if (this.child || this.stopPromise) return;
    this.requested = true;
    this.stopping = false;
    clearTimeout(this.restartTimer);
    this.failure = null;
    const daemon = findDaemon(this.opts);
    if (!daemon) {
      this.fail(this.opts.app.isPackaged
        ? 'Nekko service is missing from this install (resources/bin/nekkod). Reinstall Nekko Agent; if it keeps happening, an antivirus may have quarantined it.'
        : 'nekkod is not built. Run `npm run build:dev` (or `cargo build -p nekkod`), then restart Nekko service from the tray.');
      return;
    }
    const backendEnv: Record<string, string> = {
      ELECTRON_RUN_AS_NODE: '1',
      // Where the app-local Visual C++ runtime is, for llama.cpp builds (the
      // daemon sets this itself for the backend it supervises).
      NEKKOD_RUNTIME_DIR: dirname(daemon),
      NEKKO_BACKEND_DATA_DIR: this.opts.dataDir,
      NEKKO_BACKEND_APP: JSON.stringify(this.opts.app),
      NEKKO_BACKEND_ORIGINS: JSON.stringify(this.opts.origins),
      ...(this.opts.browserBridge ? {
        NEKKO_BROWSER_URL: this.opts.browserBridge.url,
        NEKKO_BROWSER_TOKEN: this.opts.browserBridge.token,
      } : {}),
    };
    const backend = { exe: process.execPath, args: [join(this.opts.mainDir, 'backend.js')], env: backendEnv };

    const marker = DAEMON_READY;
    // The daemon runs the browser and capture tools itself and reaches the
    // in-app browser through the same bridge (in its config, not its env).
    // `appVersion` and `edition` answer `app:info`, which the daemon serves.
    const config = { token: this.token, allowedOrigins: this.opts.origins, backend, dataDir: this.opts.dataDir, allowBrowserControl: true, appVersion: this.opts.app.version, edition: 'desktop', native: nativeConfig(this.opts.app), ...(this.opts.browserBridge ? { browserBridge: this.opts.browserBridge } : {}) };
    const child = spawn(daemon, [], {
      env: { ...process.env, NEKKOD_CONFIG: JSON.stringify(config) },
      stdio: ['pipe', 'pipe', 'inherit'],
      windowsHide: true,
    });
    this.child = child;
    const startedAt = Date.now();

    const lines = createInterface({ input: child.stdout! });
    lines.on('line', (line) => {
      if (this.stopping || this.child !== child) return;
      const at = line.indexOf(marker);
      if (at < 0) {
        console.log(line);
        return;
      }
      try {
        const { port } = JSON.parse(line.slice(at + marker.length)) as { port: number };
        this.current = { url: `http://127.0.0.1:${port}`, token: this.token };
        const waiting = this.waiters;
        this.waiters = [];
        waiting.forEach(w => { clearTimeout(w.timer); w.resolve(this.current!); });
      } catch {
        console.error(`engine: unreadable ready line: ${line}`);
      }
    });

    child.on('error', (err) => console.error(`engine: ${err.message}`));
    child.on('exit', (code, signal) => {
      this.current = null;
      this.child = null;
      if (this.stopping) return;
      if (Date.now() - startedAt > 30_000) this.backoff = 500;
      if (isMissingDllExit(code)) {
        this.fail('Nekko service could not start: Windows could not load a DLL it needs, usually the Microsoft Visual C++ Runtime. Reinstall Nekko Agent, or install the Visual C++ Redistributable, then restart Nekko service from the tray.');
        return;
      }
      console.error(`engine: nekkod exited (${signal ?? code}); restarting in ${this.backoff}ms`);
      this.restartTimer = setTimeout(() => { if (this.requested && !this.stopping) this.start(); }, this.backoff);
      this.backoff = Math.min(Math.max(this.backoff * 2, 500), MAX_BACKOFF_MS);
    });
  }

  /** Report why the engine cannot run: every waiting call gets the reason, and nothing restarts until `start()`. */
  private fail(reason: string): void {
    this.failure = reason;
    console.error(`engine: ${reason}`);
    const waiting = this.waiters;
    this.waiters = [];
    waiting.forEach(w => { clearTimeout(w.timer); w.reject(new Error(reason)); });
  }

  /** Close its stdin (the shutdown signal), then kill it if it lingers. */
  stop(graceMs = 6000): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.requested = false;
    this.current = null;
    clearTimeout(this.restartTimer);
    for (const waiter of this.waiters) { clearTimeout(waiter.timer); waiter.reject(new Error('Nekko service was stopped.')); }
    this.waiters = [];
    const child = this.child;
    if (!child || child.exitCode !== null) return Promise.resolve();
    this.stopPromise = new Promise<void>((resolveStop, reject) => {
      const timer = setTimeout(() => {
        child.kill();
      }, graceMs);
      const deadline = setTimeout(() => reject(new Error('Nekko service did not stop. Restart was cancelled to avoid duplicate processes.')), graceMs + 5000);
      child.once('exit', () => {
        clearTimeout(timer);
        clearTimeout(deadline);
        resolveStop();
      });
      child.stdin?.end();
    }).finally(() => { this.stopPromise = null; });
    return this.stopPromise;
  }

  /** One call on the engine's HTTP route, for the few things main still asks it. */
  async call<T>(channel: string, ...args: unknown[]): Promise<T> {
    const { url, token } = await this.endpoint();
    const res = await fetch(`${url}/api/${channel}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ args }),
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    const body = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(body?.error ?? `${channel}: HTTP ${res.status}`);
    return body as T;
  }
}
