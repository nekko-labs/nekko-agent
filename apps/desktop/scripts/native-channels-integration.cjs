// Visible desktop check for the native channels nekkod took over from
// Electron main (PF14): run the built app in an isolated sandbox (its own
// data dir, home, AppData and LocalAppData; a loopback update feed; the
// worktree's nekkod; never the user's app or data), drive it from inside
// (native-channels-sandbox.cjs), capture the screen when the daemon's dialogs
// are up, and kill every process it started.
//
//   node apps/desktop/scripts/native-channels-integration.cjs [outDir]
//
// Opens real windows on the desktop: run it on a machine where that is fine.
// The "installer" the updater runs is a stand-in (crates/nekkod/examples/
// fake_installer.rs) that only records its arguments; nothing is installed.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const cp = require('node:child_process');

const repo = path.resolve(__dirname, '../../..');
const out = path.resolve(process.argv[2] || path.join(repo, '.shots', `native-channels-${Date.now()}`));
const isolated = path.join(out, 'isolated');
for (const d of ['data', 'home', 'appdata', 'localappdata', 'temp', 'profile', 'feed']) fs.mkdirSync(path.join(isolated, d), { recursive: true });
const exe = process.platform === 'win32' ? '.exe' : '';
const nekkod = path.join(repo, 'target', 'release', `nekkod${exe}`);
const installer = path.join(repo, 'target', 'debug', 'examples', `fake_installer${exe}`);
for (const f of [nekkod, installer]) if (!fs.existsSync(f)) throw Error(`Build it first: ${f}`);

function capture(name, spec) {
  // Only the app window and the window nekkod drew over it (their union, in
  // physical pixels), never the rest of the desktop.
  const file = path.join(out, `${name}.png`);
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'native-channels-capture.ps1'), '-Out', file, '-Hwnds', spec.hwnds.join(',')];
  if (spec.maskNavOf) args.push('-MaskNavOf', String(spec.maskNavOf), '-MaskFrac', String(spec.maskFrac ?? 0.15));
  const r = cp.spawnSync('powershell.exe', args, { windowsHide: true, encoding: 'utf8' });
  return { file, region: (r.stdout || '').trim(), error: (r.stderr || '').trim() || undefined };
}

function processTree() {
  const ps = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath | ConvertTo-Json -Compress';
  return JSON.parse(cp.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, maxBuffer: 64 << 20 }).toString());
}
function descendants(rows, root) {
  const all = new Set([root]);
  for (let grew = true; grew;) { grew = false; for (const r of rows) if (all.has(r.ParentProcessId) && !all.has(r.ProcessId)) { all.add(r.ProcessId); grew = true; } }
  return all;
}

async function main() {
  // The loopback feed: electron-builder's latest.yml naming the stand-in installer.
  const bytes = fs.readFileSync(installer);
  const sha512 = crypto.createHash('sha512').update(bytes).digest('base64');
  // Launched from a script entry, the app reports Electron's version as its
  // own (a packaged app reports 0.8.1): offer a version newer than either.
  const version = `${Number(require(path.join(repo, 'node_modules', 'electron', 'package.json')).version.split('.')[0]) + 1}.0.0`;
  const name = `NekkoAgent-${version}-x64.exe`;
  const yml = `version: ${version}\nfiles:\n  - url: ${name}\n    sha512: ${sha512}\n    size: ${bytes.length}\npath: ${name}\nsha512: ${sha512}\nreleaseDate: '2026-10-17T00:00:00.000Z'\n`;
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/feed/latest.yml') { res.writeHead(200, { 'Content-Type': 'text/yaml' }); res.end(yml); return; }
    if (req.url === `/feed/${name}`) { res.writeHead(200, { 'Content-Length': bytes.length }); res.end(bytes); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const feed = `http://127.0.0.1:${server.address().port}/feed/`;

  const env = {
    ...process.env,
    NEKKO_NATIVE_OUT: out,
    NEKKO_APP_DIR: path.join(repo, 'apps', 'desktop'),
    NEKKO_DATA_DIR: path.join(isolated, 'data'),
    NEKKOD_PATH: nekkod,
    NEKKO_UPDATE_FEED_URL: feed,
    NEKKO_UPDATE_CACHE_DIR: path.join(isolated, 'update-cache'),
    USERPROFILE: path.join(isolated, 'home'),
    HOME: path.join(isolated, 'home'),
    APPDATA: path.join(isolated, 'appdata'),
    LOCALAPPDATA: path.join(isolated, 'localappdata'),
    TEMP: path.join(isolated, 'temp'),
    TMP: path.join(isolated, 'temp'),
  };
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  const electron = require(path.join(repo, 'node_modules', 'electron'));
  const child = cp.spawn(electron, [path.join(__dirname, 'native-channels-sandbox.cjs'), `--user-data-dir=${path.join(isolated, 'profile')}`], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = fs.createWriteStream(path.join(out, 'app.log'));
  child.stdout.pipe(log); child.stderr.pipe(log);
  let tree = new Set([child.pid]);
  const remember = () => { try { tree = new Set([...tree, ...descendants(processTree(), child.pid)]); } catch { /* best effort */ } };
  const captures = {};
  const deadline = Date.now() + 150_000;
  const exited = new Promise((r) => child.once('exit', r));
  let done = false;
  exited.then(() => { done = true; });
  while (!done && Date.now() < deadline) {
    for (const want of fs.readdirSync(out).filter((f) => f.startsWith('want-'))) {
      const key = want.slice(5);
      await new Promise((r) => setTimeout(r, 600));
      remember();
      captures[key] = capture(key, JSON.parse(fs.readFileSync(path.join(out, want), 'utf8')));
      fs.renameSync(path.join(out, want), path.join(out, `done-${key}`));
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  remember();
  await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))]);
  // The stand-in installer records its arguments beside the downloaded copy.
  const ran = path.join(isolated, 'update-cache', 'pending', name.replace(/\.exe$/, '.ran.json'));
  for (let i = 0; i < 40 && !fs.existsSync(ran); i++) await new Promise((r) => setTimeout(r, 250));
  const installerRan = fs.existsSync(ran) ? JSON.parse(fs.readFileSync(ran, 'utf8')) : null;
  // Kill everything this run started, by tree (Electron, nekkod, the backend).
  const rows = processTree();
  const alive = rows.filter((r) => tree.has(r.ProcessId));
  for (const r of alive) cp.spawnSync('taskkill', ['/PID', String(r.ProcessId), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  server.close();
  const left = processTree().filter((r) => tree.has(r.ProcessId)).map((r) => `${r.ProcessId} ${r.Name}`);
  const report = fs.existsSync(path.join(out, 'report.json')) ? JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8')) : null;
  const summary = { out, feed, requests, captures, installerRan, appExited: done, killedAtEnd: alive.map((r) => `${r.ProcessId} ${r.Name}`), leftRunning: left, report };
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
