import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { ENV_PREFIXES } from '@nekko-agent/shared';

/**
 * The engine daemon outside the desktop app: find `nekkod`, start it, keep it
 * running, stop it on exit. Used by the Local Web UI (`apps/local-web-ui`),
 * the CLI's local mode and `nekko-agent mcp` (lib.ts), and relay-agent mode.
 *
 * The same topology as the desktop app (see `apps/desktop/src/main/engine-process.ts`):
 * nekkod binds a random loopback port with a per-launch token and serves
 * every channel itself, with no TS backend beside it.
 */

/** The npm package that carries this platform's daemon (an optional dependency of the npx bundle). */
export function nekkodPackageName(platform: string = process.platform, arch: string = process.arch): string {
  // Windows on Arm runs the x64 build under emulation (its package lists both CPUs).
  if (platform === 'win32' && arch === 'arm64') return '@nekko-agent/nekkod-win32-x64';
  return `@nekko-agent/nekkod-${platform}-${arch}`;
}

export interface FindOptions {
  /** Directory of the running script (`dist/` in the repo, the bundle's folder from npm). */
  here: string;
  env?: Record<string, string | undefined>;
  platform?: string;
  arch?: string;
  /** Resolves a package's `package.json`; injectable for tests. */
  resolvePackage?: (name: string) => string | null;
}

export interface FoundDaemon {
  path: string;
  /** Where it came from, for the startup log. */
  source: 'NEKKOD_PATH' | 'npm package' | 'bundled' | 'app' | 'cargo build';
}

function defaultResolvePackage(name: string): string | null {
  try {
    return createRequire(import.meta.url).resolve(`${name}/package.json`);
  } catch {
    return null;
  }
}

/**
 * The daemon binary, in order: an explicit `NEKKOD_PATH`, this platform's npm
 * package, a `bin/` folder beside the script (the Docker image), the installed
 * app's `resources/bin` (the CLI the app ships runs from `resources/cli`),
 * then a cargo build in a development checkout, newest of release and debug
 * (as the desktop does: preferring release once ran a stale daemon against a
 * fresh host).
 */
export function findNekkod(opts: FindOptions): FoundDaemon | null {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const exe = platform === 'win32' ? 'nekkod.exe' : 'nekkod';
  const override = env.NEKKOD_PATH;
  if (override) return existsSync(override) ? { path: override, source: 'NEKKOD_PATH' } : null;

  const pkgJson = (opts.resolvePackage ?? defaultResolvePackage)(nekkodPackageName(platform, opts.arch ?? process.arch));
  if (pkgJson) {
    const bin = join(dirname(pkgJson), 'bin', exe);
    if (existsSync(bin)) return { path: bin, source: 'npm package' };
  }

  const bundled = join(opts.here, 'bin', exe);
  if (existsSync(bundled)) return { path: bundled, source: 'bundled' };
  const app = join(opts.here, '..', 'bin', exe);
  if (existsSync(app)) return { path: app, source: 'app' };

  // apps/local-web-ui/dist or apps/cli/dist -> the repository root.
  const root = resolve(opts.here, '../../..');
  const builds = [join(root, 'target/release', exe), join(root, 'target/debug', exe)].flatMap((p) => {
    try {
      return [{ p, mtime: statSync(p).mtimeMs }];
    } catch {
      return [];
    }
  });
  builds.sort((a, b) => b.mtime - a.mtime);
  return builds[0] ? { path: builds[0].p, source: 'cargo build' } : null;
}

/**
 * The environment the daemon (and through it every terminal shell) inherits: ours, minus the public bearer token, which no child needs
 * and no shell should be able to print.
 */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const prefix of ENV_PREFIXES) delete out[`${prefix}TOKEN`];
  delete out.NEKKOD_CONFIG;
  return out;
}

export interface DaemonEndpoint {
  port: number;
  token: string;
}

export interface DaemonOptions {
  exe: string;
  dataDir: string;
  log?: (line: string) => void;
  /**
   * Whether the daemon runs subscription sign-in (OAuth). The Local Web UI
   * says no (sign-in needs the desktop's browser handoff); the CLI's local
   * engine says yes, so its subscription tokens still refresh.
   */
  signIn?: boolean;
  /** Restart a daemon that dies (servers); a one-shot command fails instead. */
  restart?: boolean;
  /**
   * Bring the local model server up at start when the settings say so
   * (`engine.autoStart`). A one-shot CLI command must not.
   */
  autoStartEngine?: boolean;
}

const READY = 'NEKKOD_READY ';
const MAX_BACKOFF_MS = 5000;
const HEALTHY_RUN_MS = 30_000;
const KILL_AFTER_TERM_MS = 3000;
/** nekkod's exit code when another daemon holds the data directory's lock (crates/nekkod/src/datalock.rs). */
export const LOCKED_EXIT = 3;

/**
 * One supervised nekkod. Restarts it with backoff when it dies; `stop()` closes its stdin, which is its shutdown
 * signal on every platform, and kills it if it lingers.
 */
export class DaemonProcess {
  readonly token = randomBytes(32).toString('hex');
  private child: ChildProcess | null = null;
  private current: DaemonEndpoint | null = null;
  private waiters: { resolve: (e: DaemonEndpoint) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }[] = [];
  private stopping = false;
  private backoff = 500;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private stopPromise: Promise<void> | null = null;
  /** Restarts so far, for /health. */
  restarts = 0;

  constructor(private readonly opts: DaemonOptions) {}

  get ready(): boolean {
    return this.current !== null;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  private log(line: string): void {
    (this.opts.log ?? console.log)(line);
  }

  /** The live endpoint, waiting up to `timeoutMs` for a (re)start. */
  endpoint(timeoutMs = 15_000): Promise<DaemonEndpoint> {
    if (this.stopping) return Promise.reject(new Error('the engine is shutting down'));
    if (this.current) return Promise.resolve(this.current);
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          reject(new Error('the engine did not become ready; it may be restarting'));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  start(): void {
    if (this.child || this.stopping) return;
    const config = {
      listen: '127.0.0.1:0',
      token: this.token,
      // This server checks Origin on the public side and never forwards it.
      allowedOrigins: [],
      dataDir: this.opts.dataDir,
      // OAuth sign-in is desktop-only in the Local Web UI: the daemon refuses its channels.
      signIn: this.opts.signIn ?? false,
      autoStartEngine: this.opts.autoStartEngine ?? true,
    };
    const child = spawn(this.opts.exe, ['--config-stdin'], {
      env: childEnv(),
      stdio: ['pipe', 'pipe', 'inherit'],
      windowsHide: true,
    });
    this.child = child;
    // The config (and its token) goes in as stdin's first line, never the
    // environment, which any process of this user can read. Stdin then stays
    // open: its end is the daemon's shutdown signal. A child that never
    // started fails the write; the 'error' below reports it.
    child.stdin?.on('error', () => {});
    child.stdin?.write(`${JSON.stringify(config)}\n`);
    const startedAt = Date.now();

    createInterface({ input: child.stdout! }).on('line', (line) => {
      if (this.child !== child) return;
      const at = line.indexOf(READY);
      if (at < 0) {
        this.log(line);
        return;
      }
      try {
        const { port } = JSON.parse(line.slice(at + READY.length)) as { port: number };
        this.current = { port, token: this.token };
        const waiting = this.waiters;
        this.waiters = [];
        for (const w of waiting) {
          clearTimeout(w.timer);
          w.resolve(this.current);
        }
      } catch {
        this.log(`[nekko-agent] nekkod printed an unreadable ready line`);
      }
    });
    let exited = false;
    const onExit = (code: number | null, signal: NodeJS.Signals | null, spawnError?: string) => {
      if (exited) return;
      exited = true;
      if (this.child === child) {
        this.child = null;
        this.current = null;
      }
      if (this.stopping) return;
      const why = spawnError
        ? `could not be started (${spawnError})`
        : code === LOCKED_EXIT
          ? `found another nekkod already running on ${this.opts.dataDir}; stop the other Nekko Agent app, CLI or Local Web UI using it`
          : `exited (${signal ?? code})`;
      if (this.opts.restart === false) {
        this.stopping = true;
        for (const w of this.waiters.splice(0)) {
          clearTimeout(w.timer);
          w.reject(new Error(`nekkod ${why} before it was ready`));
        }
        return;
      }
      if (Date.now() - startedAt > HEALTHY_RUN_MS) this.backoff = 500;
      this.log(`[nekko-agent] nekkod ${why}; restarting in ${this.backoff}ms`);
      this.restarts += 1;
      this.restartTimer = setTimeout(() => this.start(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    };
    child.on('exit', (code, signal) => onExit(code, signal));
    child.on('error', (err) => {
      this.log(`[nekko-agent] nekkod: ${err.message}`);
      // A binary that could not be spawned (ENOENT, EACCES) emits 'error'
      // and never 'exit': treat it as an exit, or nothing restarts and
      // every caller waits out its timeout.
      if (child.pid === undefined) onExit(null, null, err.message);
    });
  }

  /**
   * Close its stdin, SIGTERM it if it has not exited within `graceMs` (which
   * also cuts its own shutdown short), and SIGKILL it if even that lingers.
   */
  stop(graceMs = 8000): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.current = null;
    clearTimeout(this.restartTimer);
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.reject(new Error('the engine is shutting down'));
    }
    this.waiters = [];
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    this.stopPromise = new Promise<void>((done) => {
      const term = setTimeout(() => child.kill('SIGTERM'), graceMs);
      const kill = setTimeout(() => child.kill('SIGKILL'), graceMs + KILL_AFTER_TERM_MS);
      child.once('exit', () => {
        clearTimeout(term);
        clearTimeout(kill);
        done();
      });
      child.stdin?.end();
    });
    return this.stopPromise;
  }
}

export interface StartOptions {
  /** Directory of the running script: where to look for a bundled or installed nekkod. */
  here: string;
  dataDir: string;
  signIn?: boolean;
  autoStartEngine?: boolean;
  restart?: boolean;
  log?: (line: string) => void;
  /** How long to wait for the daemon to say it is listening. */
  readyMs?: number;
}

/** Why there is no nekkod to start, said plainly. */
export function missingNekkodMessage(env: Record<string, string | undefined> = process.env): string {
  const override = env.NEKKOD_PATH;
  return override
    ? `nekkod (the engine daemon) was not found: NEKKOD_PATH points at ${override}, which does not exist.`
    : 'nekkod (the engine daemon) was not found: no NEKKOD_PATH, no ' +
        `${nekkodPackageName()} package, no bin/ beside this script, no installed Nekko Agent app beside it and no cargo build.`;
}

/** Start nekkod (the engine daemon) and wait for it. There is no engine without it. */
export async function startNekkod(opts: StartOptions): Promise<{ daemon: DaemonProcess; found: FoundDaemon }> {
  const found = findNekkod({ here: opts.here });
  if (!found) throw new Error(missingNekkodMessage());
  const daemon = new DaemonProcess({
    exe: found.path,
    dataDir: opts.dataDir,
    signIn: opts.signIn,
    autoStartEngine: opts.autoStartEngine,
    restart: opts.restart,
    log: opts.log,
  });
  daemon.start();
  try {
    await daemon.endpoint(opts.readyMs ?? 20_000);
    return { daemon, found };
  } catch (e) {
    await daemon.stop();
    throw new Error(`nekkod at ${found.path} did not start: ${(e as Error).message}`);
  }
}

/** One call on a running daemon's HTTP route. */
export async function daemonRequest<T>(daemon: DaemonProcess, channel: string, ...args: unknown[]): Promise<T> {
  const { port, token } = await daemon.endpoint();
  const res = await fetch(`http://127.0.0.1:${port}/api/${channel}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ args }),
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(body?.error ?? `${channel}: HTTP ${res.status}`);
  return body as T;
}
