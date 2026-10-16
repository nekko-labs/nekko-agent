// Run with Node. Only this worktree's ignored .shots directory is written.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const repo = path.resolve(__dirname, '../../..');
const modules = process.env.NEKKO_TEST_MODULES || path.join(repo, 'node_modules');
const out = path.join(repo, '.shots/agent-window-defaults-integration');

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const tag = process.env.NEKKO_TEST_REVISION ? 'before' : 'after';
  const latestPath = path.join(out, `${tag}-latest.txt`);
  fs.rmSync(latestPath, { force: true });
  const sourceRevision = cp.execFileSync('git', ['rev-parse', process.env.NEKKO_TEST_REVISION || 'HEAD'], { cwd: repo, windowsHide: true, encoding: 'utf8' }).trim();
  let entry = path.join(__dirname, 'agent-window-defaults-fixture.tsx');
  let shared = path.join(repo, 'packages/shared/src/index.ts');
  if (process.env.NEKKO_TEST_REVISION) {
    const source = path.join(out, 'base-source'); fs.mkdirSync(source, { recursive: true });
    const zip = path.join(out, 'base.zip');
    cp.execFileSync('git', ['archive', '--format=zip', `--output=${zip}`, process.env.NEKKO_TEST_REVISION, 'apps/desktop/src/renderer', 'packages/shared/src'], { cwd: repo });
    // Windows has bsdtar (which reads zip) but often no python3.
    if (process.platform === 'win32') cp.execFileSync('tar', ['-xf', zip, '-C', source]);
    else cp.execFileSync('python3', ['-c', 'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', zip, source]);
    entry = path.join(out, 'base-fixture.tsx');
    fs.writeFileSync(entry, fs.readFileSync(path.join(__dirname, 'agent-window-defaults-fixture.tsx'), 'utf8').replaceAll('../src/renderer', path.join(source, 'apps/desktop/src/renderer').replaceAll('\\', '/')));
    shared = path.join(source, 'packages/shared/src/index.ts');
  }
  await require(path.join(modules, 'esbuild')).build({ entryPoints: [entry], bundle: true, jsx: 'automatic', conditions: ['style', 'browser', 'import', 'default'], format: 'iife', outfile: path.join(out, 'fixture.js'), nodePaths: [modules], alias: { '@nekko-agent/shared': shared, '@fixture/context': path.join(repo, 'packages/core/src/context/assembler.ts') }, loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl', '.wasm': 'file' } });
  const css = await require(path.join(modules, 'postcss'))([require(path.join(modules, '@tailwindcss/postcss/dist/index.js'))({ base: repo })]).process(fs.readFileSync(path.join(out, 'fixture.css'), 'utf8'), { from: path.join(out, 'fixture.css') });
  fs.writeFileSync(path.join(out, 'styled.css'), css.css);
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><html data-theme="light"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\' data: blob:; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; connect-src \'none\'"><link rel="stylesheet" href="styled.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>');
  const env = { ...process.env, NEKKO_INTEGRATION_OUT: out }; delete env.ELECTRON_RUN_AS_NODE;
  const child = cp.spawn(require(path.join(modules, 'electron')), [path.join(__dirname, 'agent-window-defaults-sandbox.cjs')], { cwd: repo, env, windowsHide: true, stdio: 'inherit' });
  const owned = new Set();
  // Remember the owned tree while it exists, so orphaned renderer/GPU children
  // can be checked after Electron exits. Never select processes by app name.
  const descendants = () => {
    if (process.platform !== 'win32') return [];
    const rows = JSON.parse(cp.execFileSync('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'], { windowsHide: true, encoding: 'utf8' }));
    const ids = new Set([child.pid]);
    for (let i = 0; i < rows.length; i++) for (const row of rows) if (ids.has(row.ParentProcessId)) ids.add(row.ProcessId);
    return [...ids];
  };
  const timer = setInterval(() => { for (const pid of descendants()) owned.add(pid); }, 1500);
  const kill = pid => { if (process.platform === 'win32') cp.spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); else { try { process.kill(pid, 'SIGKILL'); } catch {} } };
  const timeout = setTimeout(() => kill(child.pid), 120000);
  let status;
  try { status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code)); }); }
  finally { clearInterval(timer); clearTimeout(timeout); }
  await new Promise(resolve => setTimeout(resolve, 600));
  const latest = latestPath;
  if (!fs.existsSync(latest)) throw Error('Sandbox exited without a manifest');
  const dir = fs.readFileSync(latest, 'utf8');
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.sourceRevision = sourceRevision;
  manifest.sourceKind = process.env.NEKKO_TEST_REVISION ? 'git archive' : 'working tree';
  for (const pid of manifest.ownedPids || []) owned.add(pid);
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const remaining = [...owned].filter(alive);
  for (const pid of remaining) kill(pid);
  await new Promise(resolve => setTimeout(resolve, 300));
  fs.rmSync(path.join(dir, 'profile'), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  manifest.cleanup = { ownedPids: [...owned], forcedPids: remaining, remainingPids: [...owned].filter(alive), profileRemoved: !fs.existsSync(path.join(dir, 'profile')) };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  if (manifest.cleanup.remainingPids.length) throw Error('Owned process tree remains alive');
  process.exitCode = status === 0 ? 0 : 1;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
