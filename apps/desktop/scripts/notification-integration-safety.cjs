const assert = require('node:assert/strict');

// A native toast is an external desktop side effect. Never permit it on a
// self-hosted runner or a developer desktop, even when CI=true is inherited.
function assertDisposableWindowsCI(env = process.env, platform = process.platform) {
  assert.equal(platform, 'win32', 'Native notification verification requires Windows');
  for (const [key, value] of Object.entries({
    CI: 'true', GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_OS: 'Windows', NEKKO_CI_NATIVE_NOTIFICATIONS: '1',
  })) assert.equal(env[key], value, `Native notifications refused: ${key} must be ${value}`);
  assert.ok(env.GITHUB_RUN_ID && env.GITHUB_WORKSPACE, 'Native notifications require a GitHub Actions run/workspace');
}

module.exports = { assertDisposableWindowsCI };
