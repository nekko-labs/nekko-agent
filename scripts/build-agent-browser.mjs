import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, cpSync, rmSync, readFileSync, copyFileSync, renameSync, utimesSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `--dev` (npm run dev/start, CI) builds the `nekko-dev` profile from stdio.patch:
// release optimizations without fat LTO, so the 14k-line main crate compiles in
// parallel. Packaging (dist/release) passes nothing and builds `release`.
const profile = process.argv.includes('--dev') ? 'nekko-dev' : 'release';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = join(root, 'vendor/agent-browser');
const pin = JSON.parse(readFileSync(join(vendor, 'pin.json'), 'utf8'));
const upstream = join(root, '.scratch/agent-browser-upstream');
const source = join(root, '.scratch/agent-browser-native');
const platforms = { win32: 'win32', darwin: 'darwin', linux: 'linux' };
if (!platforms[process.platform] || !['x64', 'arm64'].includes(process.arch)) throw new Error('Unsupported native platform');
const name = process.platform === 'win32' ? 'agent-browser.exe' : 'agent-browser';
const destination = join(root, 'apps/desktop/resources/agent-browser', `${platforms[process.platform]}-${process.arch}`, name);
function git(args, cwd = root) { return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function stage(binary) {
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(binary, destination);
  copyFileSync(join(vendor, 'LICENSE'), join(dirname(destination), 'LICENSE'));
  copyFileSync(join(vendor, 'pin.json'), join(dirname(destination), 'pin.json'));
  console.log(destination);
}

let cargo = 'cargo';
if (process.platform === 'win32') {
  const found = execFileSync('powershell', ['-NoProfile', '-Command', '$c = Get-Command cargo -ErrorAction SilentlyContinue; if ($c) { $c.Source } else { Get-ChildItem "$env:USERPROFILE/.rustup/toolchains/*/bin/cargo.exe" -ErrorAction SilentlyContinue | Sort-Object FullName | Select-Object -First 1 -ExpandProperty FullName }'], { encoding: 'utf8' }).trim();
  if (!found) throw new Error('No installed Rust toolchain found');
  cargo = found;
}
const env = { ...process.env, PATH: `${dirname(cargo)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}` };

// Every worktree has its own .scratch, so without this each one paid a full
// build. A binary built from the same pin, patch, entrypoint, script, profile
// and toolchain is shared through the repository's common git directory.
let cached = null;
try {
  const rustc = process.platform === 'win32' && existsSync(join(dirname(cargo), 'rustc.exe')) ? join(dirname(cargo), 'rustc.exe') : 'rustc';
  const hash = createHash('sha256');
  for (const file of [join(vendor, 'pin.json'), join(vendor, 'stdio.patch'), join(vendor, 'main.rs'), fileURLToPath(import.meta.url)]) hash.update(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
  hash.update(`${profile}\n${process.platform}-${process.arch}\n${execFileSync(rustc, ['-vV'], { cwd: root, env, encoding: 'utf8' })}`);
  cached = join(resolve(root, git(['rev-parse', '--git-common-dir'])), 'agent-browser-cache', hash.digest('hex').slice(0, 16), name);
} catch { /* no git checkout or no rustc: build without the cache */ }
if (cached && existsSync(cached)) {
  stage(cached);
  process.exit(0);
}

if (!existsSync(upstream)) {
  mkdirSync(dirname(upstream), { recursive: true });
  git(['init', upstream]);
  git(['remote', 'add', 'origin', pin.repository], upstream);
  git(['fetch', '--depth=1', 'origin', pin.revision], upstream);
  git(['checkout', '--detach', pin.revision], upstream);
}
if (git(['rev-parse', 'HEAD'], upstream) !== pin.revision || git(['status', '--porcelain', '--untracked-files=all'], upstream)) throw new Error('Upstream checkout must be clean at the pinned revision');
if (git(['remote', 'get-url', 'origin'], upstream).replace(/\.git$/, '') !== pin.repository.replace(/\.git$/, '')) throw new Error('Unexpected source remote');
// A restored target-only cache can create the directory without a checkout.
// Clone separately, then overlay source while preserving cached build products.
if (!existsSync(join(source, '.git'))) {
  const checkout = mkdtempSync(join(dirname(source), 'agent-browser-checkout-'));
  git(['clone', '--no-hardlinks', upstream, checkout]);
  cpSync(checkout, source, { recursive: true });
  rmSync(checkout, { recursive: true, force: true });
}
if (git(['rev-parse', 'HEAD'], source) !== pin.revision) throw new Error('Unexpected build checkout revision');
// Never reset a dirty checkout. A repeated build accepts only our exact maintained patch.
const patch = join(vendor, 'stdio.patch');
const reverse = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'apply', '--reverse', '--check', patch], { cwd: source });
if (reverse.status !== 0) {
  if (git(['status', '--porcelain', '--untracked-files=all'], source)) throw new Error('Build checkout contains unknown changes');
  git(['apply', '--check', patch], source);
  git(['apply', patch], source);
}
git(['add', '-N', 'cli/src/nekko_main.rs'], source);
if (git(['ls-files', '--others', '--exclude-standard'], source)) throw new Error('Unexpected untracked build source');
if (!readFileSync(join(source, 'cli/src/nekko_main.rs')).equals(readFileSync(join(vendor, 'main.rs')))) throw new Error('Entrypoint and maintained patch disagree');
const expected = git(['diff', '--binary'], source).replace(/\r\n/g, '\n');
if (expected !== readFileSync(patch, 'utf8').trim().replace(/\r\n/g, '\n')) throw new Error('Build source differs from maintained patch');

// Upstream build.rs writes this placeholder during the first build and watches
// it with rerun-if-changed, so the next build always recompiled the main crate.
// Writing the same file first, with a fixed old mtime, keeps rebuilds no-ops.
const dashboard = join(source, 'packages/dashboard/out');
if (!existsSync(join(dashboard, 'index.html'))) {
  mkdirSync(dashboard, { recursive: true });
  writeFileSync(join(dashboard, 'index.html'), '<!DOCTYPE html><html><body><p>Dashboard not built. Run: cd packages/dashboard &amp;&amp; pnpm build</p></body></html>\n');
}
const epoch = new Date('2000-01-01T00:00:00Z');
utimesSync(join(dashboard, 'index.html'), epoch, epoch);
utimesSync(dashboard, epoch, epoch);

const result = spawnSync(cargo, ['build', '--locked', '--profile', profile, '--manifest-path', join(source, 'cli/Cargo.toml')], { cwd: source, env, stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);
const built = join(source, 'cli/target', profile, name);
if (cached) {
  // Copy then rename, so a concurrent build in another worktree never stages a partial file.
  mkdirSync(dirname(cached), { recursive: true });
  const partial = `${cached}.${process.pid}.partial`;
  copyFileSync(built, partial);
  try { renameSync(partial, cached); } catch { rmSync(partial, { force: true }); }
}
stage(built);
