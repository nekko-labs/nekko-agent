// Native OS interaction is restricted to an explicitly opted-in disposable hosted runner.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
function assertDisposableDesktop(env = process.env, platform = process.platform) {
  if (platform !== 'win32' || env.GITHUB_ACTIONS !== 'true' || env.RUNNER_OS !== 'Windows' || env.RUNNER_ENVIRONMENT !== 'github-hosted' || env.NEKKO_NATIVE_NOTIFICATION_CI !== 'disposable-desktop') {
    throw Error('Native toast probe refused: requires Windows GitHub Actions hosted runner and NEKKO_NATIVE_NOTIFICATION_CI=disposable-desktop. Never run on a local user desktop.');
  }
}
module.exports = { assertDisposableDesktop };
if (require.main === module) {
  // Gate before loading Electron, creating files, or spawning any child.
  assertDisposableDesktop();
  const out = path.resolve('notification-native-results');
  fs.mkdirSync(out, { recursive: true });
  const isolated = fs.mkdtempSync(path.join(out, 'isolated-'));
  for (const dir of ['home', 'appdata', 'localappdata', 'temp', 'profile']) fs.mkdirSync(path.join(isolated, dir));
  const env = { ...process.env, NEKKO_NATIVE_NOTIFICATION_OUT: out, NEKKO_NATIVE_NOTIFICATION_PROFILE: isolated, HOME: path.join(isolated, 'home'), USERPROFILE: path.join(isolated, 'home'), APPDATA: path.join(isolated, 'appdata'), LOCALAPPDATA: path.join(isolated, 'localappdata'), TEMP: path.join(isolated, 'temp'), TMP: path.join(isolated, 'temp') };
  delete env.ELECTRON_RUN_AS_NODE;
  const log = fs.createWriteStream(path.join(out, 'execution.log'));
  const child = cp.spawn(require('electron'), [path.join(__dirname, 'notification-native-ci-sandbox.cjs')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { log.write(data); process.stdout.write(data); });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; cp.spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); }, 90000);
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('close', code => {
    clearTimeout(timer); log.end();
    fs.rmSync(isolated, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    fs.writeFileSync(path.join(out, 'cleanup.json'), JSON.stringify({ isolatedRemoved: !fs.existsSync(isolated), timedOut, exitCode: code }, null, 2));
    if (timedOut) fs.writeFileSync(path.join(out, 'timeout.json'), JSON.stringify({ status: 'failed', blocker: 'Native probe exceeded 90 seconds; desktop/UIA may be unavailable.' }));
    process.exitCode = code === 0 && !timedOut ? 0 : 1;
  });
}
