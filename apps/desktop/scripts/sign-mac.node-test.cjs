const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { withVmEntitlements, vmEntitlements } = require('./sign-mac.cjs');

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
  assert.ok(!fs.readFileSync(path.join(__dirname, '..', 'build', 'entitlements.mac.plist'), 'utf8').includes(VIRT));
});

test('electron_builder_signs_through_the_hook', () => {
  const yml = fs.readFileSync(path.join(__dirname, '..', 'electron-builder.yml'), 'utf8');
  assert.match(yml, /^mac:\n(?:[ #].*\n|\n)*?  sign: scripts\/sign-mac\.cjs$/m);
});

test('app_builder_lib_is_pinned_with_electron_builder', () => {
  const d = require('../package.json').devDependencies;
  assert.match(d['app-builder-lib'], /^\d+\.\d+\.\d+$/);
  assert.equal(d['app-builder-lib'], d['electron-builder']);
});
