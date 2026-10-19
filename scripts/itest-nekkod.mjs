// A real nekkod for the scripts that drive the engine over its wire: no TS
// backend (none in its config), its own data directory and home under a
// scratch root, a per-run token, a random loopback port. `call` posts
// `/api/:channel`; `stop` ends nekkod with its whole process tree.
//
//   import { startNekkod } from './itest-nekkod.mjs';
//   const d = await startNekkod({ settings: { providers: [...] } });
//   const models = await d.call('models:list', 'p1');
//   await d.stop();
//
// The binary is `nekkod` (or `NEKKOD_PATH`), else `$CARGO_TARGET_DIR` (or
// `target`)/debug, else /release: `cargo build -p nekkod` first.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { killTree, treeOptions } from './itest-procs.mjs';

const exe = process.platform === 'win32' ? 'nekkod.exe' : 'nekkod';

/** The nekkod to run: an explicit path, `NEKKOD_PATH`, then the cargo debug build, then release. */
export function nekkodPath(explicit) {
  if (explicit) return resolve(explicit);
  if (process.env.NEKKOD_PATH) return resolve(process.env.NEKKOD_PATH);
  const target = process.env.CARGO_TARGET_DIR ?? 'target';
  const found = ['debug', 'release'].map((p) => resolve(target, p, exe)).find((p) => existsSync(p));
  if (!found) throw new Error(`no nekkod under ${target}/debug or /release: cargo build -p nekkod`);
  return found;
}

/**
 * Start nekkod on a scratch root (`root`, or a fresh temp dir removed on
 * stop). `settings` is written to the data dir's settings.json first; `env`
 * is added to what nekkod (and every server it starts) inherits.
 */
export async function startNekkod({ nekkod, settings, env = {}, root, label = 'nekkod' } = {}) {
  const ownRoot = !root;
  const dir = root ?? mkdtempSync(join(tmpdir(), `nekko-${label}-`));
  const dataDir = join(dir, 'data');
  const home = join(dir, 'home');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  if (settings) writeFileSync(join(dataDir, 'settings.json'), JSON.stringify(settings));
  const token = randomBytes(24).toString('hex');
  const child = spawn(nekkodPath(nekkod), [], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      ...env,
      NEKKOD_CONFIG: JSON.stringify({ token, dataDir, allowedOrigins: [] }),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    ...treeOptions,
  });
  let log = '';
  child.stderr.on('data', (d) => (log = (log + d).slice(-20_000)));
  const port = await new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error(`nekkod did not start in 60 s\n${log}`)), 60_000);
    createInterface({ input: child.stdout }).on('line', (l) => {
      if (l.startsWith('NEKKOD_READY ')) {
        clearTimeout(timer);
        ok(JSON.parse(l.slice('NEKKOD_READY '.length)).port);
      }
    });
    child.on('exit', (c) => {
      clearTimeout(timer);
      fail(new Error(`nekkod exited ${c}\n${log}`));
    });
  });
  const base = `http://127.0.0.1:${port}`;
  /** Post one channel; a non-2xx answer throws with the daemon's error. */
  const call = async (channel, ...args) => {
    const res = await fetch(`${base}/api/${channel}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ args }),
    });
    const text = await res.text();
    const body = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(`${channel}: ${res.status} ${body?.error ?? text}`);
    return body;
  };
  const stop = async () => {
    // Closing stdin is nekkod's shutdown signal; the tree kill ends whatever lingers.
    child.stdin.end();
    await new Promise((r) => setTimeout(r, 500));
    killTree(child);
    await new Promise((r) => setTimeout(r, 300));
    if (ownRoot) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* a child may still hold a file */ }
    }
  };
  return { port, token, base, call, stop, dataDir, home, root: dir, pid: child.pid, log: () => log };
}
