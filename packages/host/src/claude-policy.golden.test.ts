import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { expect, it } from 'vitest';
import {
  CLAUDE_AUTHS,
  CLAUDE_AWAITING_REASON,
  CLAUDE_CAPABILITIES,
  CLAUDE_CODE_UNSUPPORTED,
  CLAUDE_POLICY,
  CLAUDE_REASONS,
  type ClaudeCodeAuthStatus,
  type ClaudeProviderLike,
  claudeAuthFor,
} from '@nekko-agent/shared';

/**
 * The policy table nekkod enforces (crates/nekko-agent/src/claude_policy.rs)
 * must be the shared one (packages/shared/src/claude-policy.ts), row for row,
 * reason for reason, and the auth mapping case for case. This test writes the
 * TS side to the golden file the Rust test (crates/nekko-agent/tests/claude_policy.rs)
 * reads, and fails when the file is stale. Rewrite it with UPDATE_GOLDEN=1.
 */
const golden = join(__dirname, '..', '..', '..', 'crates', 'nekko-agent', 'tests', 'golden', 'claude-policy.json');

const AUTH_CASES: { provider: ClaudeProviderLike; status?: ClaudeCodeAuthStatus }[] = [
  { provider: { kind: 'anthropic' } },
  { provider: { kind: 'anthropic', auth: 'apikey' } },
  { provider: { kind: 'anthropic', auth: 'subscription' } },
  { provider: { kind: 'bedrock' } },
  { provider: { kind: 'vertex' } },
  { provider: { kind: 'foundry' } },
  { provider: { kind: 'openai' } },
  { provider: { kind: 'chatgpt', auth: 'subscription' } },
  { provider: { kind: 'claude-code' } },
  { provider: { kind: 'claude-code', claudeCode: { authSource: 'nekko-anthropic-key' } } },
  { provider: { kind: 'claude-code', claudeCode: { authSource: 'bedrock' } } },
  { provider: { kind: 'claude-code', claudeCode: { authSource: 'cli' } }, status: { loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' } },
  { provider: { kind: 'claude-code' }, status: { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' } },
  { provider: { kind: 'claude-code' }, status: { loggedIn: true, authMethod: 'oauth_token' } },
  { provider: { kind: 'claude-code' }, status: { loggedIn: true, authMethod: 'api_key', apiProvider: 'bedrock' } },
  { provider: { kind: 'claude-code' }, status: { loggedIn: true, authMethod: 'vertex' } },
  { provider: { kind: 'claude-code' }, status: { loggedIn: false, authMethod: 'none' } },
  { provider: { kind: 'claude-code' }, status: { loggedIn: true, authMethod: 'something-new' } },
  { provider: { kind: 'claude-code' }, status: {} },
  // The user's own auth in Claude Code wins only when Nekko did not set the key itself.
  { provider: { kind: 'claude-code', claudeCode: { authSource: 'nekko-anthropic-key' } }, status: { loggedIn: true, authMethod: 'claude.ai' } },
];

function snapshot() {
  return {
    auths: CLAUDE_AUTHS,
    capabilities: CLAUDE_CAPABILITIES,
    policy: CLAUDE_POLICY,
    reasons: CLAUDE_REASONS,
    awaitingReason: CLAUDE_AWAITING_REASON,
    claudeCodeUnsupported: CLAUDE_CODE_UNSUPPORTED,
    authCases: AUTH_CASES.map((c) => ({ ...c, auth: claudeAuthFor(c.provider, c.status) })),
  };
}

it('matches the golden file the Rust mirror is tested against', () => {
  const actual = snapshot();
  if (process.env.UPDATE_GOLDEN) {
    mkdirSync(join(golden, '..'), { recursive: true });
    writeFileSync(golden, `${JSON.stringify(actual, null, 1)}
`);
  }
  expect(JSON.parse(readFileSync(golden, 'utf8'))).toEqual(JSON.parse(JSON.stringify(actual)));
});
