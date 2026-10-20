import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { format } from 'node:util';

/**
 * The desktop app's log file (IO-33 FA-5): Electron main's console output,
 * teed to `<dataDir>/logs/app.log` and rotated at 5 MB into `app.log.1` ..
 * `app.log.3`. nekkod lists and reads it (`logs:list`, `logs:read`, redacted
 * there). The console keeps printing as before; nekkod's stdout lines that
 * main echoes land here too, and nekkod keeps its own `nekkod.log`.
 *
 * Writes are queued and appended asynchronously, one at a time, so a burst of
 * logging never blocks main's event loop with synchronous file writes.
 */

export const APP_LOG = 'app.log';
export const ROTATE_BYTES = 5 * 1024 * 1024;
export const KEEP = 3;

export interface RotatingLogFs {
  appendFile(path: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string): Promise<void>;
  size(path: string): Promise<number>;
  mkdir(path: string): Promise<void>;
}

const nodeFs: RotatingLogFs = {
  appendFile: (p, d) => appendFile(p, d, { mode: 0o600 }),
  rename: (a, b) => rename(a, b),
  rm: (p) => rm(p, { force: true }),
  size: async (p) => {
    try { return (await stat(p)).size; } catch { return 0; }
  },
  mkdir: async (p) => { await mkdir(p, { recursive: true }); },
};

export interface RotatingLog {
  write(line: string): void;
  /** Resolves once everything written so far is on disk (tests, quit). */
  flush(): Promise<void>;
}

/** An append-only log that rotates itself past `max` bytes, keeping `keep` old files. */
export function createRotatingLog(dir: string, name = APP_LOG, opts: { max?: number; keep?: number; fs?: RotatingLogFs } = {}): RotatingLog {
  const fs = opts.fs ?? nodeFs;
  const max = opts.max ?? ROTATE_BYTES;
  const keep = opts.keep ?? KEEP;
  const path = join(dir, name);
  let size: number | null = null;
  let pending: string[] = [];
  let chain: Promise<void> = Promise.resolve();
  let scheduled = false;

  const rotate = async () => {
    await fs.rm(`${path}.${keep}`);
    for (let i = keep - 1; i >= 1; i--) await fs.rename(`${path}.${i}`, `${path}.${i + 1}`).catch(() => {});
    await fs.rename(path, `${path}.1`).catch(() => {});
    size = 0;
  };

  const drain = async () => {
    scheduled = false;
    const batch = pending.join('');
    pending = [];
    if (!batch) return;
    if (size === null) {
      await fs.mkdir(dir);
      size = await fs.size(path);
    }
    const bytes = Buffer.byteLength(batch);
    if (size > 0 && size + bytes > max) await rotate();
    await fs.appendFile(path, batch);
    size += bytes;
  };

  return {
    write(line: string) {
      pending.push(line.endsWith('\n') ? line : `${line}\n`);
      if (scheduled) return;
      scheduled = true;
      // A failed write (disk full, folder gone) is dropped; logging never throws into the app.
      chain = chain.then(drain).catch(() => { size = null; });
    },
    flush: () => chain,
  };
}

const LEVELS = ['log', 'info', 'warn', 'error', 'debug'] as const;

/**
 * Tee `console.log/info/warn/error/debug` into `log`, each line stamped with
 * the time and level. Returns a function that puts the console back.
 */
export function teeConsole(log: RotatingLog, target: Pick<Console, (typeof LEVELS)[number]> = console, now: () => Date = () => new Date()): () => void {
  const originals = LEVELS.map((level) => [level, target[level]] as const);
  for (const [level, original] of originals) {
    target[level] = (...args: unknown[]) => {
      original.apply(target, args);
      try {
        const text = format(...args);
        const stamp = now().toISOString();
        log.write(text.split('\n').map((l) => `${stamp} ${level.toUpperCase()} ${l}`).join('\n'));
      } catch { /* never let logging break a caller */ }
    };
  }
  return () => { for (const [level, original] of originals) target[level] = original; };
}

/** Start the app log under `<dataDir>/logs`. */
export function startAppLog(dataDir: string): { log: RotatingLog; stop: () => void } {
  const log = createRotatingLog(join(dataDir, 'logs'));
  const stop = teeConsole(log);
  return { log, stop };
}
