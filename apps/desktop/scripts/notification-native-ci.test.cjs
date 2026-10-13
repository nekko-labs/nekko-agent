const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertDisposableDesktop } = require('./notification-native-ci.cjs');
const valid = { GITHUB_ACTIONS: 'true', RUNNER_OS: 'Windows', RUNNER_ENVIRONMENT: 'github-hosted', NEKKO_NATIVE_NOTIFICATION_CI: 'disposable-desktop' };
test('Native acceptance requires every disposable CI gate exactly', () => {
  assert.doesNotThrow(() => assertDisposableDesktop(valid, 'win32'));
  assert.throws(() => assertDisposableDesktop(valid, 'linux'), /refused/);
  for (const key of Object.keys(valid)) {
    const missing = { ...valid }; delete missing[key];
    assert.throws(() => assertDisposableDesktop(missing, 'win32'), /refused/);
    assert.throws(() => assertDisposableDesktop({ ...valid, [key]: 'TRUE' }, 'win32'), /refused/);
  }
  assert.throws(() => assertDisposableDesktop({ ...valid, RUNNER_ENVIRONMENT: 'self-hosted' }, 'win32'), /refused/);
});
