const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { withVmEntitlements, vmEntitlements, resolveProvisioningProfile } = require('./sign-mac.cjs');

const VIRT = 'com.apple.security.virtualization';

test('nekko_vm_gets_its_own_entitlements', () => {
  const base = (f) => ({ entitlements: '/app.plist', hardenedRuntime: true, f });
  const o = withVmEntitlements(base);
  assert.equal(o('/x/Nekko Agent.app/Contents/Resources/bin/nekko-vm').entitlements, vmEntitlements);
  assert.equal(o('/x/Nekko Agent.app/Contents/Resources/bin/nekko-vm').hardenedRuntime, true);
  assert.deepEqual(o('/x/Nekko Agent.app/Contents/Resources/bin/nekkod'), base('/x/Nekko Agent.app/Contents/Resources/bin/nekkod'));
});

test('vm_entitlements_grant_virtualization_only', () => {
  const keys = [...fs.readFileSync(vmEntitlements, 'utf8').matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]);
  assert.deepEqual(keys, [VIRT]);
});

test('app_entitlements_never_grant_virtualization', () => {
  for (const f of ['entitlements.mac.plist', 'entitlements.mac.inherit.plist'])
    assert.ok(!fs.readFileSync(path.join(__dirname, '..', 'build', f), 'utf8').includes(VIRT), f);
});

test('electron_builder_signs_through_the_hook', () => {
  const yml = fs.readFileSync(path.join(__dirname, '..', 'electron-builder.yml'), 'utf8');
  assert.match(yml, /^mac:\n(?:[ #].*\n|\n)*?  sign: scripts\/sign-mac\.cjs$/m);
});

test('helpers_get_their_own_entitlements_file', () => {
  const yml = fs.readFileSync(path.join(__dirname, '..', 'electron-builder.yml'), 'utf8');
  const main = yml.match(/^  entitlements: (\S+)$/m)?.[1];
  const inherit = yml.match(/^  entitlementsInherit: (\S+)$/m)?.[1];
  assert.equal(main, 'build/entitlements.mac.plist');
  assert.equal(inherit, 'build/entitlements.mac.inherit.plist');
});

test('a_missing_provisioning_profile_fails_the_signed_build', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-'));
  try {
    assert.throws(() => resolveProvisioningProfile('build/nekko-agent.provisionprofile', root), (e) => {
      assert.match(e.message, /^Provisioning profile .*build\/nekko-agent\.provisionprofile not found\./);
      assert.match(e.message, /docs\/signing\.md, "Provisioning profile"/);
      return true;
    });
    fs.mkdirSync(path.join(root, 'build'));
    fs.writeFileSync(path.join(root, 'build', 'nekko-agent.provisionprofile'), '');
    assert.equal(resolveProvisioningProfile('build/nekko-agent.provisionprofile', root), path.join(root, 'build', 'nekko-agent.provisionprofile'));
    assert.equal(resolveProvisioningProfile(undefined, root), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('app_builder_lib_is_pinned_with_electron_builder', () => {
  const d = require('../package.json').devDependencies;
  assert.match(d['app-builder-lib'], /^\d+\.\d+\.\d+$/);
  assert.equal(d['app-builder-lib'], d['electron-builder']);
});
