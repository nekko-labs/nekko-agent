import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
// Keep the downloaded runtime untouched: other worktrees may be using it.
import { createRequire } from 'node:module';
import { cpSync, existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync, spawn, execFileSync } from 'node:child_process';
import { devBanner } from './dev-banner.mjs';
const require = createRequire(import.meta.url);
const electron = require('electron');
if (process.env.ELECTRON_RUN_AS_NODE) throw new Error('Unset ELECTRON_RUN_AS_NODE before launching Nekko Agent');
const env = { ...process.env, NEKKO_DEV_OWNER: randomUUID() };
// The app quits itself cleanly when this file appears (see devLaunchProcess.ts).
const stopFile = join(tmpdir(), `nekko-dev-stop-${env.NEKKO_DEV_OWNER}`);
env.NEKKO_DEV_STOP_FILE = stopFile;
// The app writes this once its engine and API are up (see reportDevReady).
const readyFile = join(tmpdir(), `nekko-dev-ready-${env.NEKKO_DEV_OWNER}`);
env.NEKKO_DEV_READY_FILE = readyFile;
let ownedCache;
export function prepareMacBundle() {

  const cache = resolve('.dev-runtime', require('electron/package.json').version);
  const bundle = join(cache, 'Nekko Agent.app');
  const ready = join(cache, 'ready-v2');
  if (!existsSync(ready)) {
    mkdirSync(cache, { recursive: true });
    cpSync(resolve(dirname(electron), '../..'), bundle, { recursive: true, verbatimSymlinks: true });
    const iconset = join(cache, 'Nekko Agent.iconset');
    mkdirSync(iconset, { recursive: true });
    for (const size of [16, 32, 128, 256, 512]) for (const scale of [1, 2]) {
      const target = join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`);
      if (spawnSync('/usr/bin/sips', ['-z', String(size * scale), String(size * scale), resolve('build/icon.png'), '--out', target]).status !== 0) throw Error('Could not prepare development icon');
    }
    if (spawnSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', join(bundle, 'Contents/Resources/Nekko Agent.icns')]).status !== 0) throw Error('Could not build development icon');
    const plist = join(bundle, 'Contents/Info.plist');
    for (const [key, value] of Object.entries({ CFBundleName: 'Nekko Agent', CFBundleDisplayName: 'Nekko Agent', CFBundleIdentifier: 'com.nekkoagent.desktop.dev', CFBundleIconFile: 'Nekko Agent.icns', NSMicrophoneUsageDescription: 'Nekko Agent uses the microphone for dictation.', NSCameraUsageDescription: 'Nekko Agent uses the camera only when you choose to share it.' })) {
      const result = spawnSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
      if (result.status !== 0 && spawnSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${value}`, plist]).status !== 0) throw new Error('Could not set development bundle identity: ' + key);
    }
    const signed = spawnSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'inherit' });
    if (signed.status !== 0) throw new Error('Could not sign development bundle');
    writeFileSync(ready, 'signed');
  }
  // LaunchServices makes the app, not the terminal, the responsible process.
  const launcher = join(cache, 'launch.cjs');
  const wrapper = resolve('scripts/dev-launch-wrapper.cjs');
  writeFileSync(launcher, `#!/usr/bin/env node\nrequire(${JSON.stringify(wrapper)}).launch(${JSON.stringify(bundle)},${JSON.stringify(cache)});\n`, { mode: 0o755 });
  return { launcher, bundle, cache };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
if (process.platform === 'darwin') { const prepared = prepareMacBundle(); env.ELECTRON_EXEC_PATH = prepared.launcher; ownedCache = prepared.cache; }
const cli = resolve(dirname(require.resolve('electron-vite')), '../bin/electron-vite.js');
// In a terminal the launcher keeps the keyboard for its stop keys; electron-vite
// and the app don't read stdin. Elsewhere (CI, an IDE task) nothing changes.
const keys = process.stdin.isTTY;
const child = spawn(process.execPath, [cli, process.argv[2] || 'dev'], {
  env,
  stdio: keys ? ['ignore', 'inherit', 'inherit'] : 'inherit',
  // Its own process group off Windows, so a forced stop reaches every child.
  detached: process.platform !== 'win32',
});
let stopping = false;
const cleanup = () => {
  try { rmSync(stopFile, { force: true }); } catch {}
  try { rmSync(readyFile, { force: true }); } catch {}
  if (keys) try { process.stdin.setRawMode(false); } catch {}
};
child.on('exit', code => { cleanup(); process.exit(stopping ? 0 : code ?? 1); });

/** End electron-vite, Electron, the engine and anything they started. */
const killTree = () => {
  if (child.exitCode !== null) return;
  if (process.platform === 'win32') { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
};

const STOP_GRACE_MS = 10_000;
/**
 * A clean stop asks the app to quit the normal way (it stops the engine and
 * its model servers first); electron-vite exits with it. Whatever is still
 * running after the grace period, or on a second request, is killed with its
 * whole process tree.
 */
const stop = () => {
  if (stopping) { console.log('\n[nekko] Forcing stop.'); killTree(); return; }
  stopping = true;
  console.log('\n[nekko] Stopping Nekko Agent cleanly... (press again to force)');
  writeFileSync(stopFile, 'stop');
  const stopOwned = () => {
    if (ownedCache) for (const name of readdirSync(ownedCache).filter(n => /^launch-.*\.json$/.test(n))) {
      try { const receipt = JSON.parse(readFileSync(join(ownedCache, name), 'utf8')); if (receipt.owner === env.NEKKO_DEV_OWNER && Number.isInteger(receipt.pid) && receipt.pid > 0) process.kill(receipt.pid, 'SIGTERM'); } catch {}
    }
  };
  stopOwned();
  // Catch a launch that was still registering when shutdown arrived.
  const timer = setInterval(stopOwned, 100);
  setTimeout(() => { clearInterval(timer); console.log('[nekko] Still running; forcing stop.'); killTree(); }, STOP_GRACE_MS).unref();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('exit', () => { cleanup(); killTree(); });

if (keys) {
  // Raw mode: Ctrl+C arrives as a key here rather than as a signal.
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (data) => {
    const key = data.toString();
    if (key === '\r' || key === '\n' || key.toLowerCase() === 'q' || key === '\x03') stop();
  });
  console.log('[nekko] Press Enter or q to stop Nekko Agent cleanly (twice to force).');
}

// Once the app reports in, say what is running and how to stop it, after
// electron-vite's build chatter rather than lost in the middle of it.
const READY_WAIT_MS = 120_000;
const startedAt = Date.now();
const readyPoll = setInterval(() => {
  if (stopping || child.exitCode !== null) { clearInterval(readyPoll); return; }
  let info = null;
  try { info = JSON.parse(readFileSync(readyFile, 'utf8')); } catch {}
  if (!info && Date.now() - startedAt < READY_WAIT_MS) return;
  clearInterval(readyPoll);
  if (!info) { console.log('[nekko] The app has not reported in yet. Press q or Enter to stop it.'); return; }
  console.log(devBanner({ ...info, color: process.stdout.isTTY && !process.env.NO_COLOR }));
}, 300);
readyPoll.unref();
}
