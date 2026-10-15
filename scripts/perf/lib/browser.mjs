/**
 * Find and launch a headless Chromium (Chrome, Edge or Chromium, whichever the
 * machine has) with the DevTools port open.
 *
 * Frame-rate limiting and vsync are switched off unless `vsync` is asked for.
 * The latency budgets are about how long the app takes to put a change on
 * screen, and a headless
 * 60 Hz vsync would add up to a whole 16.7 ms of waiting for the next tick to
 * every sample: noise from the virtual display, not work the app did. With the
 * limiter off a frame starts as soon as the main thread is free, which is how
 * a 120 Hz (or faster) display would see the same work.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { assertPortFree, selectPage, windowsOwner, wrapperFailed } from './browser-identity.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function onPath(cmd) {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .split(/\r?\n/)
      .find(Boolean);
    return out || null;
  } catch {
    return null;
  }
}

export function findBrowser() {
  const override = process.env.PERF_BROWSER;
  if (override) {
    if (!existsSync(override)) throw new Error(`PERF_BROWSER points at ${override}, which does not exist`);
    return override;
  }
  const candidates = [];
  if (process.platform === 'win32') {
    const roots = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
    for (const r of roots) {
      candidates.push(join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      candidates.push(join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    candidates.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    candidates.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
  }
  for (const c of candidates) if (existsSync(c)) return c;
  for (const cmd of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']) {
    const hit = onPath(cmd);
    if (hit) return hit;
  }
  throw new Error('No Chrome, Edge or Chromium found. Set PERF_BROWSER to a Chromium binary.');
}

export async function launchBrowser({ port, width, height, vsync = false, gpu = true }) {
  const bin = findBrowser();
  // A successful Windows wrapper exit can leave a live browser child. Never
  // blindly retry and orphan that child or attach to a previous run's listener.
  return launchOnce(bin, { port, width, height, vsync, gpu });
}

async function launchOnce(bin, { port, width, height, vsync, gpu }) {
  await assertPortFree(port);
  const profile = mkdtempSync(join(tmpdir(), 'nekko-perf-browser-'));
  const marker = `about:blank#nekko-perf-${randomUUID()}`;
  const args = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    // A backgrounded headless tab still gets full-rate timers and frames.
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    marker,
  ];
  if (!vsync) args.unshift('--disable-frame-rate-limit', '--disable-gpu-vsync');
  // On a machine with no GPU, Chrome otherwise emulates one in software
  // (SwiftShader) for compositing and WebGL, and the numbers measure the
  // emulator. Without it, compositing is plain software and WebGL is off, so
  // the terminal draws with xterm's DOM renderer.
  if (!gpu) args.unshift('--disable-gpu', '--disable-webgl', '--disable-3d-apis');
  // CI containers run as root without the user namespaces the sandbox needs.
  // /dev/shm on a container runner is small enough to crash Chrome's renderer.
  if (process.platform === 'linux') args.unshift('--no-sandbox', '--disable-dev-shm-usage');
  const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '';
  proc.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
  let exited = null;
  proc.on('exit', (code, signal) => { exited = { code, signal }; });

  let spawnError;
  proc.on('error', (error) => { spawnError = error; });
  let lastError;
  for (let i = 0; i < 120 && !wrapperFailed(exited); i++) {
    if (spawnError) throw spawnError;
    try {
      const get = async (path) => {
        const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(1000) });
        if (!r.ok) throw new Error(`CDP HTTP ${r.status}`);
        return r.json();
      };
      const targets = await get('/json');
      // Windows de-elevation can replace the startup URL with chrome://newtab/.
      // Validate the listener's OS identity before accepting any of its pages.
      if (process.platform === 'win32') windowsOwner(bin, profile, port);
      const pageMarker = process.platform === 'win32' ? targets.find((t) => t.type === 'page')?.url : marker;
      const page = selectPage(targets, pageMarker, port);
      const version = (await get('/json/version')).Browser;
      if (!version) throw new Error('Missing browser version');
      const ownerPid = process.platform === 'win32' ? windowsOwner(bin, profile, port) : proc.pid;
      const ownedProc = { pid: ownerPid, kill: () => {
        if (process.platform !== 'win32') return proc.kill();
        if (windowsOwner(bin, profile, port) !== ownerPid) throw new Error('Browser owner changed; refusing cleanup');
        process.kill(ownerPid);
        return true;
      } };
      return { proc: ownedProc, bin, version, profile, port, wsUrl: page.webSocketDebuggerUrl };
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  // Ownership was not established: leave processes intact and report the exact
  // profile for investigation instead of killing a stale/reused PID or retrying.
  const how = exited ? `wrapper exited (code ${exited.code}, signal ${exited.signal})` : 'launch timed out';
  throw new Error(`${bin} did not expose an owned page on port ${port}: ${how}; profile=${profile}; ${lastError?.message ?? spawnError?.message ?? ''}\n${stderr.trim()}`);
}
