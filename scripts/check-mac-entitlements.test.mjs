import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { posixFixture } from './posix-fixture.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), 'check-mac-entitlements.sh');
const VIRT = '<plist><dict><key>com.apple.security.virtualization</key><true/></dict></plist>';
const MAIN = '<plist><dict><key>com.apple.application-identifier</key><string>T.app</string><key>com.apple.developer.team-identifier</key><string>T</string><key>keychain-access-groups</key><array><string>T.app.webauthn</string></array></dict></plist>';
const OK = (n, profile = '') => `virtualization entitlement: nekko-vm only (${n} binaries checked)\nrestricted entitlements: main executable only${profile}`;

// A fake app tree plus a stub codesign first on PATH. The stub reads fixtures
// keyed by basename from a separate dir, so they never count as binaries:
// <name>.ents is printed, <name>.fail makes it exit 1, else an empty plist.
const roots = [];
after(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ents-'));
  roots.push(root);
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
  const run = (arg = app, ...rest) => spawnSync('bash', [script, arg, ...rest], { encoding: 'utf8', env: { ...process.env, PATH: `${stubs}:${process.env.PATH}` } });
  return { app, bin, set, run };
}

test('only_nekko_vm_with_the_entitlement_passes', posixFixture, () => {
  const f = fixture();
  f.set('nekko-vm', 'ents');
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), OK(5));
});

test('app_or_nekkod_with_the_entitlement_fails', posixFixture, () => {
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

test('nekko_vm_without_it_fails', posixFixture, () => {
  const r = fixture().run();
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim(), 'nekko-vm lacks the virtualization entitlement.');
});

test('missing_nekko_vm_fails', posixFixture, () => {
  const f = fixture();
  rmSync(join(f.bin, 'nekko-vm'));
  const r = f.run();
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim(), `${f.app} has no nekko-vm.`);
});

test('codesign_error_fails_the_check', posixFixture, () => {
  const f = fixture();
  f.set('nekko-vm', 'ents');
  f.set('nekkod', 'fail', '');
  const r = f.run();
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim(), `codesign could not read ${join(f.bin, 'nekkod')}.`);
});

test('the_unsigned_guest_scripts_beside_nekko_vm_are_skipped', posixFixture, () => {
  const f = fixture();
  f.set('nekko-vm', 'ents');
  mkdirSync(join(f.bin, 'runner-image'));
  writeFileSync(join(f.bin, 'runner-image', 'provision.sh'), '');
  f.set('provision.sh', 'fail', '');
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), OK(5));
});

test('symlinked_nekko_vm_fails', posixFixture, () => {
  const f = fixture();
  f.set('nekko-vm', 'ents');
  renameSync(join(f.bin, 'nekko-vm'), join(f.bin, 'nekko-vm-real'));
  symlinkSync('nekko-vm-real', join(f.bin, 'nekko-vm'));
  const r = f.run();
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim(), `${join(f.bin, 'nekko-vm')} is not a regular file, so it was never checked.`);
});

test('empty_app_path_says_no_app_found', posixFixture, () => {
  const r = fixture().run('');
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim(), 'no .app found.');
});

test('the_unsigned_main_app_may_carry_restricted_entitlements_or_not', posixFixture, () => {
  const f = fixture();
  f.set('nekko-vm', 'ents');
  assert.equal(f.run().status, 0);
  f.set('Nekko Agent.app', 'ents', MAIN);
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), OK(5));
});

test('a_helper_or_nekkod_with_a_restricted_entitlement_fails', posixFixture, () => {
  for (const [name, at, ents, k] of [
    ['Nekko Agent Helper.app', (f) => join(f.app, 'Contents', 'Frameworks', 'Nekko Agent Helper.app'), MAIN, 'com.apple.application-identifier'],
    ['nekkod', (f) => join(f.bin, 'nekkod'), '<plist><dict><key>keychain-access-groups</key><array/></dict></plist>', 'keychain-access-groups'],
    ['nekko-speech', (f) => join(f.bin, 'nekko-speech'), '<plist><dict><key>com.apple.developer.team-identifier</key><string>T</string></dict></plist>', 'com.apple.developer.team-identifier'],
  ]) {
    const f = fixture();
    f.set('nekko-vm', 'ents');
    f.set(name, 'ents', ents);
    const r = f.run();
    assert.equal(r.status, 1, name);
    assert.equal(r.stderr.trim(), `${at(f)} carries ${k}, which only the main executable may (it alone has the provisioning profile).`);
  }
});

test('a_signed_app_needs_the_profile_and_the_three_entitlements', posixFixture, () => {
  const f = fixture();
  f.set('nekko-vm', 'ents');
  let r = f.run(f.app, '--signed');
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim(), 'The signed app lacks keychain-access-groups, so Touch ID passkeys cannot work.');

  f.set('Nekko Agent.app', 'ents', MAIN.replace(/<key>com\.apple\.developer\.team-identifier<\/key><string>T<\/string>/, ''));
  r = f.run(f.app, '--signed');
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim(), 'The signed app lacks com.apple.developer.team-identifier, so Touch ID passkeys cannot work.');

  f.set('Nekko Agent.app', 'ents', MAIN);
  r = f.run(f.app, '--signed');
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim(), `${f.app} embeds no provisioning profile, so macOS will refuse to launch it.`);

  writeFileSync(join(f.app, 'Contents', 'embedded.provisionprofile'), '');
  r = f.run(f.app, '--signed');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), OK(5, ', profile embedded'));
});

test('an_unknown_option_fails', posixFixture, () => {
  const f = fixture();
  f.set('nekko-vm', 'ents');
  const r = f.run(f.app, '--sign');
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim(), 'unknown option --sign.');
});
