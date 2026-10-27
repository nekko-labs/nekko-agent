#!/usr/bin/env node
// The iPhone app's bundled Mermaid (MM-1): the same package version the desktop
// ships (package-lock.json's node_modules/mermaid), copied into vendor/mermaid
// with its license and a pin recording where it came from.
//
//   node scripts/vendor-mermaid.mjs          fetch the locked version from npm, verify it, write vendor/mermaid
//   node scripts/vendor-mermaid.mjs --check  fail if vendor/mermaid is not the locked version, byte for byte
//
// The tarball's sha512 must equal the lockfile's integrity before anything is written.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'vendor', 'mermaid');
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const locked = lock.packages['node_modules/mermaid'];
if (!locked) throw new Error('package-lock.json has no node_modules/mermaid');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

if (process.argv.includes('--check')) {
  const pin = JSON.parse(readFileSync(join(out, 'pin.json'), 'utf8'));
  const problems = [];
  if (pin.version !== locked.version) problems.push(`vendor/mermaid is ${pin.version}, package-lock.json has ${locked.version}: run node scripts/vendor-mermaid.mjs`);
  if (pin.integrity !== locked.integrity) problems.push('vendor/mermaid/pin.json integrity differs from package-lock.json');
  const actual = sha256(readFileSync(join(out, 'mermaid.min.js')));
  if (actual !== pin.sha256) problems.push(`vendor/mermaid/mermaid.min.js sha256 ${actual} is not the pinned ${pin.sha256}`);
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  console.log(`vendor/mermaid: mermaid ${pin.version}, ${pin.bytes} bytes, matches package-lock.json`);
  process.exit(0);
}

const tmp = mkdtempSync(join(tmpdir(), 'mermaid-'));
try {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const name = execFileSync(npm, ['pack', `mermaid@${locked.version}`, '--pack-destination', tmp, '--silent'],
    { encoding: 'utf8', shell: process.platform === 'win32' }).trim().split('\n').pop();
  const tgz = join(tmp, name);
  const integrity = 'sha512-' + createHash('sha512').update(readFileSync(tgz)).digest('base64');
  if (integrity !== locked.integrity) throw new Error(`tarball integrity ${integrity} is not the lockfile's ${locked.integrity}`);
  execFileSync('tar', ['-xzf', name, 'package/dist/mermaid.min.js', 'package/LICENSE'], { cwd: tmp });
  const js = readFileSync(join(tmp, 'package', 'dist', 'mermaid.min.js'));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'mermaid.min.js'), js);
  writeFileSync(join(out, 'LICENSE'), readFileSync(join(tmp, 'package', 'LICENSE')));
  const pin = {
    package: 'mermaid',
    version: locked.version,
    resolved: locked.resolved,
    integrity: locked.integrity,
    file: 'dist/mermaid.min.js',
    sha256: sha256(js),
    bytes: js.length,
    license: 'MIT',
  };
  writeFileSync(join(out, 'pin.json'), JSON.stringify(pin, null, 2) + '\n');
  console.log(`vendor/mermaid: mermaid ${pin.version}, ${pin.bytes} bytes, sha256 ${pin.sha256}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
