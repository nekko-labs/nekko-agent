import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  CLAUDE_AUTHS,
  CLAUDE_AWAITING_REASON,
  CLAUDE_CAPABILITIES,
  CLAUDE_CODE_UNSUPPORTED,
  CLAUDE_POLICY,
  CLAUDE_REASONS,
  type ClaudeCodeAuthStatus,
  type ClaudeProviderLike,
  claudeAllows,
  claudeAuthFor,
  claudeCapability,
  claudeComparisonTable,
  claudeReasonText,
} from './claude-policy.js';
import { CLAUDE_PLAN_USAGE_EXAMPLE_LABEL, claudePlanUsageExample } from './claude-plan-usage-fixture.js';

/**
 * The policy table nekkod enforces (crates/nekko-agent/src/claude_policy.rs)
 * must be this one, row for row and reason for reason. This test writes the
 * TS side to a golden file the Rust test reads; it fails when the file is
 * stale. Rewrite it with UPDATE_GOLDEN=1.
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

describe('CLAUDE_POLICY', () => {
  it('matches the golden file the Rust mirror is tested against', () => {
    const actual = snapshot();
    if (process.env.UPDATE_GOLDEN) {
      mkdirSync(join(golden, '..'), { recursive: true });
      writeFileSync(golden, `${JSON.stringify(actual, null, 1)}\n`);
    }
    expect(JSON.parse(readFileSync(golden, 'utf8'))).toEqual(JSON.parse(JSON.stringify(actual)));
  });

  it('keeps every feature for API keys and clouds', () => {
    for (const auth of ['api_key', 'cloud'] as const) {
      for (const cap of CLAUDE_CAPABILITIES) expect(claudeAllows(auth, cap, 'nekko')).toBe(true);
    }
  });

  it('holds the approval-gated features off for a plan, with a reason each', () => {
    for (const cap of ['unattended_runs', 'nekko_tools', 'context_note', 'usage_limits'] as const) {
      const row = claudeCapability('subscription', cap);
      expect(row.state).toBe('awaiting_approval');
      expect(claudeReasonText(row)).toBe(CLAUDE_REASONS[CLAUDE_AWAITING_REASON[cap]].text);
    }
    expect(claudeAllows('subscription', 'interactive_chat')).toBe(true);
    expect(claudeAllows('subscription', 'phone_remote')).toBe(true);
  });

  it('fails closed: unknown is a plan', () => {
    expect(CLAUDE_POLICY.unknown).toEqual(CLAUDE_POLICY.subscription);
  });

  it('gives every non-enabled row a reason', () => {
    for (const auth of CLAUDE_AUTHS) {
      for (const cap of CLAUDE_CAPABILITIES) {
        const row = CLAUDE_POLICY[auth][cap];
        if (row.state !== 'enabled') expect(row.reason).toBeDefined();
      }
    }
  });

  it('never routes inside a Claude Code turn, on any auth', () => {
    expect(claudeCapability('api_key', 'model_routing', 'claude-code')).toEqual({ state: 'unsupported', reason: 'claude_code_owns_loop' });
    expect(claudeAllows('api_key', 'model_routing', 'nekko')).toBe(true);
  });

  it('generates the comparison table the design specifies', () => {
    const t = claudeComparisonTable();
    expect(Object.fromEntries(t.rows.map((r) => [r.capability, r.cells]))).toEqual({
      interactive_chat: ['Yes', 'Yes', 'Yes'],
      phone_remote: ['Yes', 'Yes', 'Yes'],
      unattended_runs: ['Yes', 'Yes', 'Not yet'],
      nekko_tools: ['Yes', 'Yes', 'Not yet'],
      usage_limits: ['Yes', 'Yes', 'No, check in Claude Code'],
      model_routing: ['Yes', 'No', 'No'],
    });
    expect(t.billedTo).toEqual(['Your API or cloud account', 'Your API account', 'Your Claude plan']);
  });
});

describe('claudePlanUsageExample', () => {
  it('is labelled as example data', () => {
    const fixture = claudePlanUsageExample(0);
    expect(fixture.exampleLabel).toBe(CLAUDE_PLAN_USAGE_EXAMPLE_LABEL);
    expect(CLAUDE_PLAN_USAGE_EXAMPLE_LABEL).toBe('Example data');
    expect(fixture.windows.every((w) => w.resetAt > 0)).toBe(true);
  });
});
