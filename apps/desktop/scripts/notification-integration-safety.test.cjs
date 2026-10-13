const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertDisposableWindowsCI } = require('./notification-integration-safety.cjs');
const hosted = { CI: 'true', GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', NEKKO_NATIVE_NOTIFICATION_CI: 'disposable-desktop', GITHUB_RUN_ID: '123', GITHUB_WORKSPACE: 'C:/ci/workspace' };
test('Native verification accepts only explicitly opted-in hosted Windows CI', () => {
  assert.doesNotThrow(() => assertDisposableWindowsCI(hosted, 'win32'));
  assert.throws(() => assertDisposableWindowsCI(hosted, 'linux'));
  assert.throws(() => assertDisposableWindowsCI({}, 'win32'));
  for (const key of Object.keys(hosted)) {
    const env = { ...hosted }; delete env[key];
    assert.throws(() => assertDisposableWindowsCI(env, 'win32'), key);
  }
  assert.throws(() => assertDisposableWindowsCI({ ...hosted, RUNNER_ENVIRONMENT: 'self-hosted' }, 'win32'));
  assert.throws(() => assertDisposableWindowsCI({ ...hosted, NEKKO_NATIVE_NOTIFICATION_CI: '0' }, 'win32'));
});
