const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { assertDisposableDesktop } = require('./notification-native-ci.cjs');
const valid = { CI: 'true', GITHUB_ACTIONS: 'true', RUNNER_OS: 'Windows', RUNNER_ENVIRONMENT: 'github-hosted', NEKKO_NATIVE_NOTIFICATION_CI: 'disposable-desktop', GITHUB_RUN_ID: '123', GITHUB_WORKSPACE: 'C:/ci/workspace' };
test('Native acceptance requires every disposable CI gate exactly', () => {
  assert.doesNotThrow(() => assertDisposableDesktop(valid, 'win32'));
  assert.throws(() => assertDisposableDesktop(valid, 'linux'));
  for (const key of Object.keys(valid)) {
    const missing = { ...valid }; delete missing[key];
    assert.throws(() => assertDisposableDesktop(missing, 'win32'));
    if (!['GITHUB_RUN_ID', 'GITHUB_WORKSPACE'].includes(key)) {
      assert.throws(() => assertDisposableDesktop({ ...valid, [key]: 'TRUE' }, 'win32'));
    }
  }
  assert.throws(() => assertDisposableDesktop({ ...valid, RUNNER_ENVIRONMENT: 'self-hosted' }, 'win32'));
});
test('Launcher, Electron child, and PowerShell gate before desktop side effects', () => {
  // Source checks only: never launch a native probe during local safety tests.
  const read = file => fs.readFileSync(path.join(__dirname, file), 'utf8');
  const launcher = read('notification-native-ci.cjs');
  assert.ok(launcher.indexOf('  assertDisposableDesktop();') < launcher.indexOf('  fs.mkdirSync'));
  const sandbox = read('notification-native-ci-sandbox.cjs');
  assert.ok(sandbox.indexOf('assertDisposableDesktop();') < sandbox.indexOf("require('electron')"));
  const desktop = read('notification-native-ci-desktop.ps1');
  for (const gate of ['CI', 'GITHUB_ACTIONS', 'RUNNER_OS', 'RUNNER_ENVIRONMENT', 'NEKKO_NATIVE_NOTIFICATION_CI', 'GITHUB_RUN_ID', 'GITHUB_WORKSPACE']) assert.ok(desktop.includes('$env:' + gate));
  assert.ok(desktop.indexOf('throw \'Refusing desktop') < desktop.indexOf('Add-Type'));
});
test('Injected integration cannot select the removed native mode', () => {
  const launcher = fs.readFileSync(path.join(__dirname, 'notification-engine-integration.cjs'), 'utf8');
  assert.ok(!launcher.includes('--native-ci'));
  const sandbox = fs.readFileSync(path.join(__dirname, 'notification-engine-integration-sandbox.cjs'), 'utf8');
  assert.ok(!sandbox.includes('new Notification('));
});
