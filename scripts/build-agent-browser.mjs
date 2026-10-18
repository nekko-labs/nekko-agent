import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, cpSync, rmSync, readFileSync, copyFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = join(root, 'vendor/agent-browser');
const pin = JSON.parse(readFileSync(join(vendor, 'pin.json'), 'utf8'));
const upstream = join(root, '.scratch/agent-browser-upstream');
const source = join(root, '.scratch/agent-browser-native');
function git(args, cwd = root) { return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
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
let cargo = 'cargo';
if (process.platform === 'win32') {
  const found = execFileSync('powershell', ['-NoProfile', '-Command', '$c = Get-Command cargo -ErrorAction SilentlyContinue; if ($c) { $c.Source } else { Get-ChildItem "$env:USERPROFILE/.rustup/toolchains/*/bin/cargo.exe" -ErrorAction SilentlyContinue | Sort-Object FullName | Select-Object -First 1 -ExpandProperty FullName }'], { encoding: 'utf8' }).trim();
  if (!found) throw new Error('No installed Rust toolchain found');
  cargo = found;
}
const env = { ...process.env, PATH: `${dirname(cargo)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}` };
const result = spawnSync(cargo, ['build', '--locked', '--release', '--manifest-path', join(source, 'cli/Cargo.toml')], { cwd: source, env, stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);
const platforms = { win32: 'win32', darwin: 'darwin', linux: 'linux' };
if (!platforms[process.platform] || !['x64', 'arm64'].includes(process.arch)) throw new Error('Unsupported native platform');
const name = process.platform === 'win32' ? 'agent-browser.exe' : 'agent-browser';
const destination = join(root, 'apps/desktop/resources/agent-browser', `${platforms[process.platform]}-${process.arch}`, name);
mkdirSync(dirname(destination), { recursive: true });
copyFileSync(join(source, 'cli/target/release', name), destination);
copyFileSync(join(vendor, 'LICENSE'), join(dirname(destination), 'LICENSE'));
copyFileSync(join(vendor, 'pin.json'), join(dirname(destination), 'pin.json'));
console.log(destination);
