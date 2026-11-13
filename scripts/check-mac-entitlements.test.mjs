import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { posixFixture } from './posix-fixture.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), 'check-mac-entitlements.sh');
const VIRT = '<plist><dict><key>com.apple.security.virtualization</key><true/></dict></plist>';
const MAIN = '<plist><dict><key>com.apple.application-identifier</key><string>T.app</string><key>com.apple.developer.team-identifier</key><string>T</string><key>keychain-access-groups</key><array><string>T.app.webauthn</string></array></dict></plist>';
const OK = (n, profile = '') => `virtualization entitlement: nekko-vm only (${n} binaries checked)\nrestricted entitlements: main executable only${profile}`;
const AUTHORIZED = ', authorized by the embedded profile';

// A fake app tree plus a stub codesign first on PATH. The stub reads fixtures
// keyed by basename from a separate dir, so they never count as binaries:
// <name>.ents is printed, <name>.fail makes it exit 1, else an empty plist.
// A stub node stands in for check-provisioning-profile.cjs: it records its
// arguments in node.args, and profile.fail makes it exit 1.
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
  writeFileSync(join(stubs, 'node'), `#!/bin/bash
printf '%s\\n' "$@" > "${fx}/node.args"
[ -e "${fx}/profile.fail" ] && { echo 'profile does not authorize keychain-access-groups'; exit 1; }
echo 'provisioning profile OK'
`);
  chmodSync(join(stubs, 'node'), 0o755);
  const set = (name, ext, body = VIRT) => writeFileSync(join(fx, `${name}.${ext}`), body);
  const run = (arg = app, ...rest) => spawnSync('bash', [script, arg, ...rest], { encoding: 'utf8', env: { ...process.env, PATH: `${stubs}:${process.env.PATH}` } });
  const checked = () => { try { return readFileSync(join(fx, 'node.args'), 'utf8').trim().split('\n'); } catch { return undefined; } };
  const embed = () => writeFileSync(join(app, 'Contents', 'embedded.provisionprofile'), '');
  return { app, bin, set, run, checked, embed };
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

test('a_main_app_with_restricted_entitlements_and_no_profile_fails_signed_or_not', posixFixture, () => {
  // 0.10.1000: keychain-access-groups on the main executable, nothing embedded (#2688).
  const f = fixture();
  f.set('nekko-vm', 'ents');
  f.set('Nekko Agent.app', 'ents', '<plist><dict><key>keychain-access-groups</key><array><string>T.app.webauthn</string></array></dict></plist>');
  const r = f.run();
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim(), `${f.app} carries keychain-access-groups but embeds no provisioning profile, so macOS will refuse to launch it.`);
  assert.equal(f.checked(), undefined);
});

test('a_main_app_without_restricted_entitlements_needs_no_profile', posixFixture, () => {
  const f = fixture();
  f.set('nekko-vm', 'ents');
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), OK(5));
  assert.equal(f.checked(), undefined);
});

test('the_ad_hoc_dry_run_copy_skips_the_profile', posixFixture, () => {
  const f = fixture();
  f.set('nekko-vm', 'ents');
  f.set('Nekko Agent.app', 'ents', MAIN);
  const r = f.run(f.app, '--ad-hoc');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), OK(5));
  assert.equal(f.checked(), undefined);
});

test('an_embedded_profile_must_authorize_the_main_app', posixFixture, () => {
  const f = fixture();
  f.set('nekko-vm', 'ents');
  f.set('Nekko Agent.app', 'ents', MAIN);
  f.embed();
  let r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), OK(5, AUTHORIZED));
  const args = f.checked();
  assert.match(args[0], /apps\/desktop\/scripts\/check-provisioning-profile\.cjs$/);
  assert.deepEqual(args.slice(1), ['--app', f.app]);

  f.set('profile', 'fail', '');
  r = f.run();
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr.trim(), 'profile does not authorize keychain-access-groups');
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
  assert.equal(r.stderr.trim(), `${f.app} carries com.apple.application-identifier but embeds no provisioning profile, so macOS will refuse to launch it.`);

  f.embed();
  r = f.run(f.app, '--signed');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), OK(5, AUTHORIZED));
  assert.deepEqual(f.checked().slice(1), ['--app', f.app]);
});

test('an_unknown_option_fails', posixFixture, () => {
  const f = fixture();
  f.set('nekko-vm', 'ents');
  const r = f.run(f.app, '--sign');
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim(), 'unknown option --sign.');
});

test('signed_and_ad_hoc_together_fail', posixFixture, () => {
  const f = fixture();
  f.set('nekko-vm', 'ents');
  const r = f.run(f.app, '--signed', '--ad-hoc');
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim(), 'at most one option.');
});
