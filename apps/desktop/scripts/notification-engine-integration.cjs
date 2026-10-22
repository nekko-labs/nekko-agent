// Real-engine verification launcher. Writes only to this task's scratch directory.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const repo = path.resolve(__dirname, '../../..');
const scratch = path.join(repo, '.shots/notification-engine');
const inspect = () => JSON.parse(cp.execFileSync('powershell', ['-NoProfile', '-Command', 'ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine)'], { windowsHide: true, encoding: 'utf8' }));
async function main() {
  const args = process.argv.slice(2);
  // `--daemon` is accepted for older invocations; nekkod is the only engine.
  assert.ok(args.every(arg => arg === '--daemon'), 'Unknown integration argument');
  fs.mkdirSync(scratch, { recursive: true });
  const out = fs.mkdtempSync(path.join(scratch, 'run-'));
  const isolated = path.join(out, 'isolated');
  const before = inspect();
  fs.writeFileSync(path.join(out, 'processes-before.json'), JSON.stringify(before, null, 2));
  for (const dir of ['home', 'appdata', 'localappdata', 'data', 'profile', 'temp']) fs.mkdirSync(path.join(isolated, dir), { recursive: true });
  fs.writeFileSync(path.join(isolated, 'data/settings.json'), JSON.stringify({ desktopNotifications: true, providers: [], mcpServers: [], updates: { app: false, modelLists: false, skills: false }, autoUpdate: false, engine: { autoStart: false }, apiServer: { enabled: false, startOnLaunch: false, port: 1439, bind: 'local', token: 'scratch-only' } }));
  const workspace = Object.fromEntries(['shared'].map(name => ['@nekko-agent/' + name, path.join(repo, 'packages', name, 'src/index.ts')]));
  const build = async (entry, outfile) => require('esbuild').build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node22', plugins: [{ name: 'workspace-source-only', setup(b) { b.onResolve({ filter: /^[^./]|^@/ }, args => { if (workspace[args.path]) return { path: workspace[args.path] }; if (!path.isAbsolute(args.path)) return { path: args.path, external: true }; }); } }] });
  const entry = path.join(out, 'entry.ts');
  fs.writeFileSync(entry, `export { EngineProcess } from ${JSON.stringify(path.join(repo, 'apps/desktop/src/main/engine-process.ts'))}; export * from ${JSON.stringify(path.join(repo, 'apps/desktop/src/main/notifications.ts'))}; export { IpcChannels, IpcEvents } from '@nekko-agent/shared';`);
  await build(entry, path.join(out, 'integration-api.cjs'));
  const daemonPath = path.resolve(process.env.NEKKO_NOTIFICATION_INTEGRATION_DAEMON_PATH || path.join(repo, 'target/debug/nekkod.exe'));
  assert.ok(fs.existsSync(daemonPath), 'nekkod missing: ' + daemonPath);
  const env = { ...process.env, NEKKO_NOTIFICATION_INTEGRATION_OUT: out, NEKKOD_PATH: daemonPath, NEKKO_DATA_DIR: path.join(isolated, 'data'), USERPROFILE: path.join(isolated, 'home'), HOME: path.join(isolated, 'home'), APPDATA: path.join(isolated, 'appdata'), LOCALAPPDATA: path.join(isolated, 'localappdata'), TEMP: path.join(isolated, 'temp'), TMP: path.join(isolated, 'temp') };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NEKKOD_URL; delete env.NEKKOD_TOKEN;
  let child;
  let code;
  const owned = new Set();
  const rememberTree = () => {
    const rows = inspect();
    if (child?.pid) owned.add(child.pid);
    let size;
    do { size = owned.size; for (const row of rows) if (owned.has(row.ParentProcessId)) owned.add(row.ProcessId); } while (size !== owned.size);
  };
  let poll;
  try {
    child = cp.spawn(require('electron'), [path.join(__dirname, 'notification-engine-integration-sandbox.cjs')], { cwd: repo, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const log = fs.createWriteStream(path.join(out, 'execution.log'));
    child.stdout.on('data', chunk => { process.stdout.write(chunk); log.write(chunk); });
    child.stderr.on('data', chunk => { process.stderr.write(chunk); log.write(chunk); });
    rememberTree();
    poll = setInterval(rememberTree, 2000);
    code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { rememberTree(); cp.spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); reject(Error('Integration exceeded 90 seconds')); }, 90000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', value => { clearTimeout(timer); resolve(value); });
    });
    log.end();
  } finally {
    clearInterval(poll);
    // Kill descendants captured while the root was alive, even after a crash orphaned them.
    const remaining = inspect();
    for (const row of remaining) if (owned.has(row.ProcessId) && !before.some(old => old.ProcessId === row.ProcessId)) cp.spawnSync('taskkill', ['/PID', String(row.ProcessId), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    fs.rmSync(isolated, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    const after = inspect();
    const survivors = after.filter(row => owned.has(row.ProcessId));
    const cleanup = { ownedPids: [...owned], survivors, isolatedRemoved: !fs.existsSync(isolated) };
    fs.writeFileSync(path.join(out, 'cleanup.json'), JSON.stringify(cleanup, null, 2));
    assert.equal(survivors.length, 0, 'Owned process survived cleanup');
    assert.equal(cleanup.isolatedRemoved, true);
    console.log('CLEANUP PASS: owned process tree and isolated home/data/profile removed');
    console.log('Evidence:', out);
  }
  assert.equal(code, 0, 'Electron integration failed; inspect execution.log and results.json');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
