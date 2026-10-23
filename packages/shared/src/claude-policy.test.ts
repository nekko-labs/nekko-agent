import { describe, expect, it } from 'vitest';
import {
  claudeAccountName,
  isClaudeAccountName,
  CLAUDE_AUTHS,
  CLAUDE_AWAITING_REASON,
  CLAUDE_CAPABILITIES,
  CLAUDE_POLICY,
  CLAUDE_REASONS,
  claudeAllows,
  claudeCapability,
  claudeComparisonTable,
  claudeReasonText,
  claudeUnattendedRefusal,
  reportedClaudeCodeContext,
} from './claude-policy.js';
import { CLAUDE_PLAN_USAGE_EXAMPLE_LABEL, claudePlanUsageExample } from './claude-plan-usage-fixture.js';

describe('CLAUDE_POLICY', () => {
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

describe('claudeUnattendedRefusal', () => {
  const plan = { kind: 'claude-code', claudeCode: { authSource: 'cli' } };
  const planStatus = { loggedIn: true, authMethod: 'claude.ai' };

  it('refuses an unattended Claude Code turn on a plan, with the reason', () => {
    expect(claudeUnattendedRefusal(plan, planStatus)).toBe('Scheduled runs need Claude with an API key.');
    // No status: unknown, which fails closed.
    expect(claudeUnattendedRefusal(plan)).toBe('Scheduled runs need Claude with an API key.');
  });

  it('runs it with the row forced on, as a signed override would', () => {
    const on = structuredClone(CLAUDE_POLICY);
    on.subscription.unattended_runs = { state: 'enabled' };
    expect(claudeUnattendedRefusal(plan, planStatus, on)).toBeNull();
  });

  it('never gates an API key, a cloud or a Nekko-engine provider', () => {
    expect(claudeUnattendedRefusal({ kind: 'claude-code', claudeCode: { authSource: 'nekko-anthropic-key' } })).toBeNull();
    expect(claudeUnattendedRefusal({ kind: 'claude-code', claudeCode: { authSource: 'foundry' } })).toBeNull();
    expect(claudeUnattendedRefusal({ kind: 'anthropic', auth: 'subscription' })).toBeNull();
    expect(claudeUnattendedRefusal({ kind: 'openai' })).toBeNull();
  });
});

describe('reportedClaudeCodeContext', () => {
  const claudeCodeContext = { used: 21_002, window: 1_000_000, model: 'claude-opus-5-5', modelId: 'opus' };
  it('gives Claude Code\'s figures while the chat keeps the model they were reported for', () => {
    expect(reportedClaudeCodeContext({ modelId: 'opus', claudeCodeContext })).toEqual({ used: 21_002, window: 1_000_000 });
    expect(reportedClaudeCodeContext({ modelId: 'opus', claudeCodeContext }, 'sonnet')).toBeUndefined();
    expect(reportedClaudeCodeContext({ modelId: 'opus' })).toBeUndefined();
  });
});

describe('Claude Code account names', () => {
  // Same cases as nekko_harness::account::tests::names, so both sides agree.
  it('accepts what nekkod accepts', () => {
    for (const ok of ['work', 'a', 'client-2', 'x'.repeat(32)]) expect(isClaudeAccountName(ok)).toBe(true);
    for (const bad of ['', 'Work', '-a', 'a-', 'a/b', '..', 'a b', 'ä', 'x'.repeat(33)]) expect(isClaudeAccountName(bad)).toBe(false);
  });
  it('turns a typed label into a valid name, or nothing', () => {
    expect(claudeAccountName('Work (Acme)')).toBe('work-acme');
    expect(claudeAccountName('  Client A  ')).toBe('client-a');
    expect(claudeAccountName('ÄÖ')).toBe('');
    expect(isClaudeAccountName(claudeAccountName('a'.repeat(31) + ' b'))).toBe(true);
  });
});
