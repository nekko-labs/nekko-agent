const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { assertDisposableWindowsCI } = require('./notification-integration-safety.cjs');
const permitted = { CI: 'true', GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', NEKKO_CI_NATIVE_NOTIFICATIONS: '1', GITHUB_RUN_ID: '123', GITHUB_WORKSPACE: 'scratch' };
test('native fixture requires every hosted Windows CI opt-in', () => {
  assert.doesNotThrow(() => assertDisposableWindowsCI(permitted, 'win32'));
  for (const key of Object.keys(permitted)) {
    const env = { ...permitted }; delete env[key];
    assert.throws(() => assertDisposableWindowsCI(env, 'win32'));
  }
  assert.throws(() => assertDisposableWindowsCI({ ...permitted, RUNNER_ENVIRONMENT: 'self-hosted' }, 'win32'));
  assert.throws(() => assertDisposableWindowsCI(permitted, 'darwin'));
});
test('both entrypoints refuse before loading Electron or creating artifacts', () => {
  for (const file of ['native-notification-ci.cjs', 'native-notification-ci-sandbox.cjs']) {
    const run = spawnSync(process.execPath, [path.join(__dirname, file)], { env: { ...process.env, NEKKO_CI_NATIVE_NOTIFICATIONS: '0' }, encoding: 'utf8', windowsHide: true });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /Native notifications refused|requires Windows/);
  }
});
