import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'check-mac-entitlements.sh');
const VIRT = '<plist><dict><key>com.apple.security.virtualization</key><true/></dict></plist>';

// A fake app tree plus a stub codesign first on PATH. The stub reads fixtures
// keyed by basename from a separate dir, so they never count as binaries:
// <name>.ents is printed, <name>.fail makes it exit 1, else an empty plist.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ents-'));
  const app = join(root, 'Nekko Agent.app');
  const bin = join(app, 'Contents', 'Resources', 'bin');
  for (const d of [join(app, 'Contents', 'MacOS'), join(app, 'Contents', 'Frameworks', 'Nekko Agent Helper.app', 'Contents', 'MacOS'), bin])
    mkdirSync(d, { recursive: true });
  for (const f of ['nekkod', 'nekko-speech', 'nekko-vm']) writeFileSync(join(bin, f), '');
  const fx = join(root, 'fx');
  const stubs = join(root, 'stubs');
  mkdirSync(fx);
  mkdirSync(stubs);
  writeFileSync(join(stubs, 'codesign'), `#!/bin/bash
for a; do p="$a"; done
n=$(basename "$p")
[ -e "${fx}/$n.fail" ] && { echo "$p: code object is not signed at all" >&2; exit 1; }
[ -e "${fx}/$n.ents" ] && { cat "${fx}/$n.ents"; exit 0; }
echo '<plist><dict/></plist>'
`);
  chmodSync(join(stubs, 'codesign'), 0o755);
  const set = (name, ext, body = VIRT) => writeFileSync(join(fx, `${name}.${ext}`), body);
  const run = (arg = app) => spawnSync('bash', [script, arg], { encoding: 'utf8', env: { ...process.env, PATH: `${stubs}:${process.env.PATH}` } });
  return { app, bin, set, run };
}

test('only_nekko_vm_with_the_entitlement_passes', () => {
  const f = fixture();
  f.set('nekko-vm', 'ents');
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'virtualization entitlement: nekko-vm only (5 binaries checked)');
});

test('app_or_nekkod_with_the_entitlement_fails', () => {
  const f = fixture();
  f.set('nekko-vm', 'ents');
  f.set('Nekko Agent.app', 'ents');
  let r = f.run();
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim(), `${f.app} carries the virtualization entitlement.`);
  f.set('Nekko Agent.app', 'ents', '<plist><dict/></plist>');
  f.set('nekkod', 'ents');
  r = f.run();
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim(), `${join(f.bin, 'nekkod')} carries the virtualization entitlement.`);
});

test('nekko_vm_without_it_fails', () => {
  const r = fixture().run();
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim(), 'nekko-vm lacks the virtualization entitlement.');
});

test('missing_nekko_vm_fails', () => {
  const f = fixture();
  rmSync(join(f.bin, 'nekko-vm'));
  const r = f.run();
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim(), `${f.app} has no nekko-vm.`);
});

test('codesign_error_fails_the_check', () => {
  const f = fixture();
  f.set('nekko-vm', 'ents');
  f.set('nekkod', 'fail', '');
  const r = f.run();
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim(), `codesign could not read ${join(f.bin, 'nekkod')}.`);
});

test('symlinked_nekko_vm_fails', () => {
  const f = fixture();
  f.set('nekko-vm', 'ents');
  renameSync(join(f.bin, 'nekko-vm'), join(f.bin, 'nekko-vm-real'));
  symlinkSync('nekko-vm-real', join(f.bin, 'nekko-vm'));
  const r = f.run();
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim(), `${join(f.bin, 'nekko-vm')} is not a regular file, so it was never checked.`);
});

test('empty_app_path_says_no_app_found', () => {
  const r = fixture().run('');
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim(), 'no .app found.');
});
