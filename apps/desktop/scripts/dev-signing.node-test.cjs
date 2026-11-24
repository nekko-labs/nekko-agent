const test = require('node:test');
const assert = require('node:assert/strict');
const { resolve } = require('node:path');
const { devSigningIdentity, DEV_IDENTITY } = require('./dev-signing.cjs');

const repo = resolve(__dirname, '../../..');
const apple = '0123456789ABCDEF0123456789ABCDEF01234567';
const localConfig = ['git', ['-C', repo, 'config', '--local', '--get', 'nekko.devSigningIdentity']];
const findIdentity = ['/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']];

function select(env, { local = { status: 1 }, identities = '', platform = 'darwin' } = {}) {
  const calls = [];
  const value = devSigningIdentity(env, { platform, run(cmd, args) {
    calls.push([cmd, args]);
    return cmd === 'git' ? local : { status: 0, stdout: identities };
  } });
  return { value, calls };
}

test('uses the explicitly saved Apple Development identity from this checkout', () => {
  assert.deepEqual(select({}, { local: { status: 0, stdout: `${apple}\n` } }), { value: apple, calls: [localConfig] });
});

test('the one-run override takes precedence over repository config, including ad-hoc', () => {
  assert.deepEqual(select({ NEKKO_DEV_SIGN_IDENTITY: apple }), { value: apple, calls: [] });
  assert.deepEqual(select({ NEKKO_DEV_SIGN_IDENTITY: '-' }), { value: null, calls: [] });
  assert.deepEqual(select({}, { local: { status: 0, stdout: '-\n' } }), { value: null, calls: [localConfig] });
});

test('no opt-in still uses only the dedicated self-signed identity if present', () => {
  const personal = '1) A "Apple Development: Example (TEAM)"';
  assert.deepEqual(select({}, { identities: personal }), { value: null, calls: [localConfig, findIdentity] });
  assert.deepEqual(select({}, { identities: `${personal}\n2) B "${DEV_IDENTITY}"` }), { value: DEV_IDENTITY, calls: [localConfig, findIdentity] });
});

test('CI skips local Git config; other platforms do not invoke Git or Keychain', () => {
  assert.deepEqual(select({ CI: 'true' }, { local: { status: 0, stdout: apple } }), { value: null, calls: [findIdentity] });
  assert.deepEqual(select({}, { platform: 'linux' }), { value: null, calls: [] });
});
