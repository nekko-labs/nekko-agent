// Separate manual local acceptance path. Never imports the disposable CI desktop helper.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
function assertLocalOptIn(args = process.argv.slice(2), platform = process.platform) {
  if (platform !== 'win32' || args.length !== 1 || args[0] !== '--allow-local-notification-test') {
    throw Error('Requires Windows and explicit --allow-local-notification-test. Sends one real silent toast; manual click opens an isolated TEST window. No settings changes.');
  }
}
module.exports = { assertLocalOptIn };
if (require.main === module) {
  assertLocalOptIn(); // Before loading Electron or creating scratch files.
  const out = path.resolve('.shots', 'notification-native-local-' + Date.now());
  fs.mkdirSync(out, { recursive: true });
  const isolated = fs.mkdtempSync(path.join(out, 'isolated-'));
  for (const dir of ['home', 'appdata', 'localappdata', 'temp', 'profile']) fs.mkdirSync(path.join(isolated, dir));
  require('esbuild').buildSync({ entryPoints: [path.join(__dirname, '../src/main/nativeNotifications.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(isolated, 'adapter.cjs') });
  const env = { ...process.env, NEKKO_LOCAL_NOTIFICATION_OPT_IN: 'manual-single-toast', NEKKO_LOCAL_NOTIFICATION_OUT: out, NEKKO_LOCAL_NOTIFICATION_PROFILE: isolated, HOME: path.join(isolated, 'home'), USERPROFILE: path.join(isolated, 'home'), APPDATA: path.join(isolated, 'appdata'), LOCALAPPDATA: path.join(isolated, 'localappdata'), TEMP: path.join(isolated, 'temp'), TMP: path.join(isolated, 'temp') };
  delete env.ELECTRON_RUN_AS_NODE;
  const log = fs.createWriteStream(path.join(out, 'execution.log'));
  const child = cp.spawn(require('electron'), [path.join(__dirname, 'notification-native-local-sandbox.cjs')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  console.log(JSON.stringify({ out, pid: child.pid, title: 'Nekko notification test (isolated)', clickWaitSeconds: 90, clickedHoldSeconds: 20, hardDeadlineSeconds: 120 }));
  fs.writeFileSync(path.join(out, 'launch.json'), JSON.stringify({ pid: child.pid, isolated, title: 'Nekko notification test (isolated)' }, null, 2));
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { log.write(data); process.stdout.write(data); });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; cp.spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); }, 120000);
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('close', code => {
    clearTimeout(timer); log.end();
    fs.rmSync(isolated, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    fs.writeFileSync(path.join(out, 'cleanup.json'), JSON.stringify({ isolatedRemoved: !fs.existsSync(isolated), timedOut, exitCode: code }, null, 2));
    process.exitCode = code === 0 && !timedOut ? 0 : 1;
    console.log('LOCAL TEST COMPLETE: ' + out + ' (exit ' + code + ')');
  });
}
