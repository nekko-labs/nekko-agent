import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeEnv, userLine } from './claude-code-probe.mjs';

test('the probe never hands Claude Code a login, only an explicit test key', () => {
  const base = {
    PATH: '/bin',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
    ANTHROPIC_AUTH_TOKEN: 'bearer',
    CLAUDE_CODE_USE_BEDROCK: '1',
    ANTHROPIC_API_KEY: 'test-key',
  };
  assert.deepEqual(probeEnv(base, '/tmp/cfg', false), { PATH: '/bin', CLAUDE_CONFIG_DIR: '/tmp/cfg' });
  assert.deepEqual(probeEnv(base, '/tmp/cfg', true), { PATH: '/bin', ANTHROPIC_API_KEY: 'test-key', CLAUDE_CONFIG_DIR: '/tmp/cfg' });
});

test('user turns are one stream-json line each', () => {
  assert.equal(userLine('hi'), '{"type":"user","message":{"role":"user","content":"hi"}}\n');
});
