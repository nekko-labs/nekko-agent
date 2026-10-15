// Explicit, dry-run-first cleanup. Never removes worktrees, evidence or models.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const inside = (root, path) => path === root || path.startsWith(root + sep);
export function measure(root) {
  let bytes = 0, newest = 0;
  const stack = [root];
  while (stack.length) {
    const path = stack.pop(), stat = lstatSync(path);
    if (stat.isSymbolicLink()) continue;
    newest = Math.max(newest, stat.mtimeMs);
    if (stat.isDirectory()) for (const name of readdirSync(path)) stack.push(join(path, name));
    else {
      if (/\.(gguf|ggml|safetensors|onnx|pt|pth|ckpt)$/i.test(path)) throw new Error('Contains possible model weights; preserved');
      bytes += stat.size;
    }
  }
  return { bytes, newest };
}
export function eligible(path, tracked, protectedPaths) {
  if (lstatSync(path).isSymbolicLink()) return 'link';
  if (protectedPaths.some(p => inside(path, p) || inside(p, path))) return 'active or protected path';
  if (tracked.some(p => inside(path, p))) return 'contains tracked files';
  return null;
}

export function main(args = process.argv.slice(2)) {
  const apply = args.includes('--apply');
  const ageArg = args.find(a => a.startsWith('--older-than='));
  const days = ageArg ? Number(ageArg.split('=')[1]) : 14;
  if (!Number.isFinite(days) || days < 0) throw new Error('Invalid --older-than days');
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const git = (cwd, argv) => execFileSync('git', argv, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  const trees = git(repo, ['worktree', 'list', '--porcelain']).split(/\r?\n/).filter(l => l.startsWith('worktree ')).map(l => resolve(l.slice(9)));
  // Protect the primary checkout by default, including consumers that use junctions into it.
  const protectedPaths = [join(trees[0], 'node_modules'), join(trees[0], 'apps', 'desktop', 'node_modules'), join(trees[0], 'apps', 'desktop', '.dev-runtime'), join(trees[0], 'apps', 'desktop', 'out'), join(trees[0], 'target', 'dev-daemon')];
  const extra = args.filter(a => a.startsWith('--protect=')).map(a => resolve(a.slice(10)));
  protectedPaths.push(...extra);
  // Refuse cleanup if any build/install process is active. Never kill user processes.
  if (process.platform === 'win32') {
    const json = execFileSync('powershell.exe', ['-NoProfile', '-Command', "@(Get-CimInstance Win32_Process | Select-Object Name,ExecutablePath,CommandLine) | ConvertTo-Json -Compress"], { encoding: 'utf8', windowsHide: true });
    const processes = JSON.parse(json || '[]');
    if (processes.some(p => /^(cargo|rustc|rustup|msbuild|cmake|ninja)\.exe$/i.test(p.Name) || (/^node\.exe$/i.test(p.Name) && /npm-cli\.js.*\b(ci|install|rebuild)\b/.test(p.CommandLine || '')))) throw new Error('Build/install is running; retry after it finishes.');
    for (const p of processes) {
      if (p.ExecutablePath && /(?:electron|nekko|node|chrome)/i.test(p.Name)) protectedPaths.push(resolve(dirname(p.ExecutablePath)));
      const command = (p.CommandLine || '').replaceAll('\\', '/').toLowerCase();
      for (const tree of trees.slice(1)) if (command.includes(tree.replaceAll('\\', '/').toLowerCase() + '/')) protectedPaths.push(tree);
    }
  } else if (apply && !args.includes('--idle-confirmed')) {
    throw new Error('On Unix, stop builds/apps first and pass --idle-confirmed; automatic process ownership detection is not implemented.');
  }
  const candidates = [], skippedTrees = [];
  for (const tree of trees) {
    if (!existsSync(tree)) continue;
    let tracked;
    try { tracked = git(tree, ['ls-files', '-z']).split('\0').filter(Boolean).map(p => resolve(tree, p)); }
    catch { skippedTrees.push({ path: tree, reason: 'Cannot verify tracked files (Git ownership/access); left untouched' }); continue; }
    const visit = dir => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || ['.git', '.shots', '.worktrees', '.agents'].includes(entry.name)) continue;
        const path = join(dir, entry.name);
        if (['node_modules', 'target', 'dist', 'out', '.dev-runtime'].includes(entry.name)) {
          if (entry.name === 'target' && tree === trees[0]) {
            for (const sub of readdirSync(path, { withFileTypes: true })) if (sub.isDirectory() && !sub.isSymbolicLink()) candidates.push({ path: join(path, sub.name), tracked });
          } else if (tree !== trees[0]) candidates.push({ path, tracked });
          // Other primary outputs may be loaded lazily by the live dev app.
        } else visit(path);
      }
    };
    visit(tree);
  }
  // Known historical shared Rust pools, not arbitrary unregistered directories.
  for (const name of ['rust-core-target', 'rust-engine-target', 'rust-services-target', 'rust-retire-target', 'rust-workspace-target']) {
    const path = join(trees[0], '.worktrees', name);
    if (existsSync(path)) candidates.push({ path, tracked: [] });
  }
  if (args.includes('--global')) for (const parts of [['AppData','Local','npm-cache'],['AppData','Local','electron'],['AppData','Local','electron-builder'],['AppData','Local','ms-playwright'],['.cache','puppeteer'],['.cache','selenium'],['.cache','firebase'],['.cargo','registry'],['.cargo','git']]) {
    const path = join(homedir(), ...parts);
    if (existsSync(path)) candidates.push({ path, tracked: [] });
  }
  const results = [];
  const seen = new Set();
  for (const { path, tracked } of candidates) {
    if (seen.has(path)) continue;
    seen.add(path);
    let reason = eligible(path, tracked, protectedPaths);
    if (reason) { results.push({ path, status: 'kept', reason }); continue; }
    try {
      const { bytes, newest } = measure(path);
      if (Date.now() - newest < days * 86400000) reason = 'recently modified';
      if (reason) { results.push({ path, bytes, status: 'kept', reason }); continue; }
      if (apply) rmSync(path, { recursive: true, force: false });
      results.push({ path, bytes, status: apply ? 'removed' : 'candidate' });
    } catch (error) { results.push({ path, status: 'failed', error: error.message }); }
  }
  console.log(JSON.stringify({ apply, days, skippedTrees, modelPolicy: 'No model directories or user app data are enumerated', results, totalBytes: results.filter(r => ['removed','candidate'].includes(r.status)).reduce((s,r) => s + r.bytes, 0) }, null, 2));
  if (results.some(r => r.status === 'failed')) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
