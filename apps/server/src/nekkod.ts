import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { ENV_PREFIXES } from '@nekko-agent/shared';

/**
 * The web edition's engine daemon: find `nekkod`, start it, keep it running,
 * stop it on exit.
 *
 * The same topology as the desktop app (see `apps/desktop/src/main/engine-process.ts`):
 * nekkod binds a random loopback port with a per-launch token, owns the
 * channels it has ported (terminals, session storage, the inference router,
 * MCP, the agent run) and starts a TS host backend for the rest. Here the
 * backend is this same script run with `--nekko-backend` under the Node that
 * runs us, since there is no Electron binary to borrow.
 */

export type DaemonMode = 'auto' | 'nekkod' | 'ts';

/** `NEKKO_DAEMON`: `auto` (default), `nekkod` (require the daemon) or `ts` (in-process host). */
export function daemonMode(value: string | undefined): DaemonMode {
  const v = (value ?? '').trim().toLowerCase();
  if (v === 'nekkod' || v === 'on' || v === '1' || v === 'daemon') return 'nekkod';
  if (v === 'ts' || v === 'off' || v === '0' || v === 'inprocess') return 'ts';
  return 'auto';
}

/** The npm package that carries this platform's daemon (an optional dependency of the npx bundle). */
export function nekkodPackageName(platform: string = process.platform, arch: string = process.arch): string {
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
  source: 'NEKKOD_PATH' | 'npm package' | 'bundled' | 'cargo build';
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
 * package, a `bin/` folder beside the script (the Docker image), then a cargo
 * build in a development checkout, newest of release and debug (as the
 * desktop does: preferring release once ran a stale daemon against a fresh host).
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

  // apps/server/dist -> the repository root.
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
 * The environment the daemon (and through it the backend and every terminal
 * shell) inherits: ours, minus the public bearer token, which no child needs
 * and no shell should be able to print.
 */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const prefix of ENV_PREFIXES) delete out[`${prefix}TOKEN`];
  delete out.NEKKOD_CONFIG;
  return out;
}

/**
 * How to start this script as the TS backend. Node 20 and 21 hide the global
 * WebSocket the host's terminal client uses behind a flag; 22 has it on.
 */
export function backendCommand(script: string, extraEnv: Record<string, string>): { exe: string; args: string[]; env: Record<string, string> } {
  const major = Number(process.versions.node.split('.')[0]);
  const flags = major < 22 ? ['--experimental-websocket'] : [];
  return { exe: process.execPath, args: [...flags, script, '--nekko-backend'], env: extraEnv };
}

export interface DaemonEndpoint {
  port: number;
  token: string;
}

export interface DaemonOptions {
  exe: string;
  dataDir: string;
  backend: { exe: string; args: string[]; env: Record<string, string> };
  log?: (line: string) => void;
}

const READY = 'NEKKOD_READY ';
const MAX_BACKOFF_MS = 5000;
const HEALTHY_RUN_MS = 30_000;

/**
 * One supervised nekkod. Restarts it with backoff when it dies (nekkod in turn
 * restarts the backend); `stop()` closes its stdin, which is its shutdown
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
      backend: this.opts.backend,
      dataDir: this.opts.dataDir,
      // OAuth sign-in is desktop-only (web-channels.ts): the daemon answers its channels with the same refusal.
      signIn: false,
    };
    const child = spawn(this.opts.exe, [], {
      env: { ...childEnv(), NEKKOD_CONFIG: JSON.stringify(config) },
      stdio: ['pipe', 'pipe', 'inherit'],
      windowsHide: true,
    });
    this.child = child;
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
    child.on('error', (err) => this.log(`[nekko-agent] nekkod: ${err.message}`));
    child.on('exit', (code, signal) => {
      if (this.child === child) {
        this.child = null;
        this.current = null;
      }
      if (this.stopping) return;
      if (Date.now() - startedAt > HEALTHY_RUN_MS) this.backoff = 500;
      this.log(`[nekko-agent] nekkod exited (${signal ?? code}); restarting in ${this.backoff}ms`);
      this.restarts += 1;
      this.restartTimer = setTimeout(() => this.start(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    });
  }

  /** Close its stdin, then kill it if it has not exited within `graceMs`. */
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
      const timer = setTimeout(() => child.kill('SIGKILL'), graceMs);
      child.once('exit', () => {
        clearTimeout(timer);
        done();
      });
      child.stdin?.end();
    });
    return this.stopPromise;
  }
}
