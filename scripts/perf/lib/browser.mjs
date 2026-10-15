/**
 * Find and launch a headless Chromium (Playwright's Chromium, Chrome or
 * Chromium, whichever the machine has) with the DevTools port open. Never
 * Edge: it is the user's own browser on Windows, and a headless copy of it
 * shows up in their Task Manager next to their real one.
 *
 * `close()` ends the whole process tree and deletes the throwaway profile:
 * killing only the browser process left GPU and renderer children running
 * on Windows.
 *
 * Frame-rate limiting and vsync are switched off unless `vsync` is asked for.
 * The latency budgets are about how long the app takes to put a change on
 * screen, and a headless
 * 60 Hz vsync would add up to a whole 16.7 ms of waiting for the next tick to
 * every sample: noise from the virtual display, not work the app did. With the
 * limiter off a frame starts as soon as the main thread is free, which is how
 * a 120 Hz (or faster) display would see the same work, but only while frames
 * keep carrying damage; run.mjs keeps them flowing (FRAME_PUMP in probes.mjs).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function onPath(cmd) {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
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
  const candidates = [playwrightChromium()].filter(Boolean);
  if (process.platform === 'win32') {
    const roots = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
    for (const r of roots) candidates.push(join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    candidates.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
  }
  for (const c of candidates) if (existsSync(c)) return c;
  for (const cmd of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const hit = onPath(cmd);
    if (hit) return hit;
  }
  throw new Error('No Chromium found. Run `npx playwright install chromium`, or set PERF_BROWSER to a Chromium binary.');
}

/** The newest Chromium Playwright has downloaded, if any. */
function playwrightChromium() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH
    || (process.platform === 'win32' ? join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
      : process.platform === 'darwin' ? join(homedir(), 'Library', 'Caches', 'ms-playwright')
        : join(homedir(), '.cache', 'ms-playwright'));
  let dirs = [];
  try { dirs = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1])); } catch { return null; }
  const inside = process.platform === 'win32' ? [['chrome-win64', 'chrome.exe'], ['chrome-win', 'chrome.exe']]
    : process.platform === 'darwin' ? [['chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'], ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium']]
      : [['chrome-linux64', 'chrome'], ['chrome-linux', 'chrome']];
  for (const d of dirs) for (const parts of inside) {
    const bin = join(root, d, ...parts);
    if (existsSync(bin)) return bin;
  }
  return null;
}

/**
 * End a spawned process and everything it started. Chromium's GPU, renderer
 * and utility processes, and the web edition's ptys and tool children, outlive
 * a plain `kill()` of their parent on Windows.
 */
export function killTree(proc) {
  if (!proc?.pid || proc.exitCode !== null) return;
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* already gone */ }
  } else {
    // Spawned detached, so the pid leads its own process group.
    try { process.kill(-proc.pid, 'SIGKILL'); } catch { try { proc.kill('SIGKILL'); } catch { /* already gone */ } }
  }
}

export async function launchBrowser({ port, width, height, vsync = false, gpu = true }) {
  const bin = findBrowser();
  // A cold Chrome on a shared runner sometimes never opens its DevTools page
  // (the 2026-10-08 perf failures). That was reported as a bare "no page
  // target" with the browser's own output thrown away. Keep the output, give
  // it longer, and try once more on a fresh port and profile before failing.
  for (let attempt = 1; ; attempt++) {
    try {
      return await launchOnce(bin, { port: port + (attempt - 1) * 7, width, height, vsync, gpu });
    } catch (error) {
      if (attempt >= 2) throw error;
      console.warn(`[perf] browser launch attempt ${attempt} failed, retrying: ${error.message.split('\n')[0]}`);
    }
  }
}

async function launchOnce(bin, { port, width, height, vsync, gpu }) {
  const profile = mkdtempSync(join(tmpdir(), 'nekko-perf-browser-'));
  const args = [
    // Prevent Windows Chrome from re-launching outside the owned process tree.
    ...(process.platform === 'win32' ? ['--do-not-de-elevate'] : []),
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
    'about:blank',
  ];
  if (!vsync) args.unshift('--disable-frame-rate-limit', '--disable-gpu-vsync');
  // On a machine with no GPU, Chrome otherwise emulates one in software
  // (SwiftShader) for compositing and WebGL, and the numbers measure the
  // emulator. Without it, compositing is plain software and WebGL is off, so
  // the terminal draws with xterm's DOM renderer.
  if (!gpu) args.unshift('--disable-gpu', '--disable-webgl', '--disable-3d-apis');
  // A GPU in software, the same on every machine: GPU-style tiling and raster
  // policy, which is what memory figures need to mean anything.
  if (gpu === 'swiftshader') args.unshift('--use-angle=swiftshader', '--enable-unsafe-swiftshader');
  // CI containers run as root without the user namespaces the sandbox needs.
  // /dev/shm on a container runner is small enough to crash Chrome's renderer.
  if (process.platform === 'linux') args.unshift('--no-sandbox', '--disable-dev-shm-usage');
  const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
  const close = async () => {
    killTree(proc);
    // The profile stays locked until every child has exited.
    for (let i = 0; i < 20; i++) {
      try { rmSync(profile, { recursive: true, force: true }); return; } catch { await sleep(150); }
    }
  };
  let stderr = '';
  proc.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
  let exited = null;
  proc.on('exit', (code, signal) => { exited = { code, signal }; });

  let targets = null;
  for (let i = 0; i < 120 && !exited; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json`);
      targets = await r.json();
      if (targets.some((t) => t.type === 'page')) break;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  const page = targets?.find((t) => t.type === 'page');
  if (!page) {
    await close();
    const how = exited ? `exited (code ${exited.code}, signal ${exited.signal})` : 'still running after 30 s';
    throw new Error(`${bin} did not expose a page target on port ${port}: ${how}${stderr.trim() ? `\n--- browser stderr (tail) ---\n${stderr.trim()}` : ''}`);
  }
  let version = '';
  try {
    version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).Browser ?? '';
  } catch {
    /* informational only */
  }
  return { proc, bin, version, wsUrl: page.webSocketDebuggerUrl, close };
}
