import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

/**
 * The engine, from the window's side: start it, know where it listens, keep it
 * running, stop it on quit.
 *
 * Normally that is `nekkod` (the Rust daemon), which in turn starts and
 * supervises the TS backend. If the daemon binary is missing (a development
 * checkout that never ran `cargo build`, or an antivirus that quarantined
 * it), the TS backend is started directly instead, so the app still works
 * with the TS terminals; `mode` says which one is running.
 *
 * The Electron main process never runs the engine itself any more: a busy
 * agent loop, a pty flood or a synchronous file write there used to stall
 * window management and every IPC reply the UI waited on.
 */

export interface EngineEndpoint {
  /** `http://127.0.0.1:<port>` */
  url: string;
  token: string;
  mode: 'daemon' | 'backend';
}

export interface EngineOptions {
  browserBridge?: { url: string; token: string };
  dataDir: string;
  /** Plain facts about the app the backend needs (see `backend/index.ts`). */
  app: { isPackaged: boolean; appPath: string; userData: string; version: string; resourcesPath?: string };
  /** Page origins allowed to open sockets: the packaged `null` and, in dev, the renderer server. */
  origins: string[];
  /** Where the Electron main bundle lives (`out/main`), next to `backend.js`. */
  mainDir: string;
}

const DAEMON_READY = 'NEKKOD_READY ';
const BACKEND_READY = 'NEKKO_BACKEND_READY ';
const MAX_BACKOFF_MS = 5000;

/**
 * The daemon binary: packaged resources, an explicit override, or a local cargo
 * build. In a development checkout the newer of the release and debug builds
 * wins: always preferring release once ran a days-old release daemon against a
 * fresh host, and the two disagreed about what the host was asking for.
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
  private readonly token = randomBytes(24).toString('base64url');

  constructor(private readonly opts: EngineOptions) {}

  /** Resolves with the live endpoint, waiting for a (re)start if needed. */
  endpoint(): Promise<EngineEndpoint> {
    if (!this.running) return Promise.reject(new Error('Nekko service is stopped. Start it from the tray menu.'));
    if (this.current) return Promise.resolve(this.current);
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
    const daemon = findDaemon(this.opts);
    const backendEnv: Record<string, string> = {
      ELECTRON_RUN_AS_NODE: '1',
      NEKKO_BACKEND_DATA_DIR: this.opts.dataDir,
      NEKKO_BACKEND_APP: JSON.stringify(this.opts.app),
      NEKKO_BACKEND_ORIGINS: JSON.stringify(this.opts.origins),
      ...(this.opts.browserBridge ? {
        NEKKO_BROWSER_URL: this.opts.browserBridge.url,
        NEKKO_BROWSER_TOKEN: this.opts.browserBridge.token,
      } : {}),
    };
    const backend = { exe: process.execPath, args: [join(this.opts.mainDir, 'backend.js')], env: backendEnv };

    let child: ChildProcess;
    let marker: string;
    let mode: EngineEndpoint['mode'];
    if (daemon) {
      mode = 'daemon';
      marker = DAEMON_READY;
      // The desktop host lets the agent drive a browser, so a turn the daemon admits offers it too.
      const config = { token: this.token, allowedOrigins: this.opts.origins, backend, dataDir: this.opts.dataDir, allowBrowserControl: true };
      child = spawn(daemon, [], {
        env: { ...process.env, NEKKOD_CONFIG: JSON.stringify(config) },
        stdio: ['pipe', 'pipe', 'inherit'],
        windowsHide: true,
      });
    } else {
      mode = 'backend';
      marker = BACKEND_READY;
      console.warn('nekkod not found; running the TS backend directly (TS terminals, no daemon)');
      child = spawn(backend.exe, backend.args, {
        env: { ...process.env, ...backendEnv, NEKKO_BACKEND_TOKEN: this.token },
        stdio: ['pipe', 'pipe', 'inherit'],
        windowsHide: true,
      });
    }
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
        this.current = { url: `http://127.0.0.1:${port}`, token: this.token, mode };
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
      console.error(`engine: ${mode} exited (${signal ?? code}); restarting in ${this.backoff}ms`);
      this.restartTimer = setTimeout(() => { if (this.requested && !this.stopping) this.start(); }, this.backoff);
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    });
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
