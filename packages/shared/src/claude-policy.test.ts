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
  claudeAccountCheck,
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
    for (const cap of ['unattended_runs', 'nekko_tools', 'context_note'] as const) {
      const row = claudeCapability('subscription', cap);
      expect(row.state).toBe('awaiting_approval');
      expect(claudeReasonText(row)).toBe(CLAUDE_REASONS[CLAUDE_AWAITING_REASON[cap]].text);
    }
    expect(claudeAllows('subscription', 'interactive_chat')).toBe(true);
    expect(claudeAllows('subscription', 'phone_remote')).toBe(true);
    // What the user's own Claude Code reports about the plan.
    expect(claudeAllows('subscription', 'usage_limits')).toBe(true);
  });

  it('fails closed: unknown is a plan without plan usage', () => {
    expect(CLAUDE_POLICY.unknown).toEqual({ ...CLAUDE_POLICY.subscription, usage_limits: { state: 'awaiting_approval', reason: 'usage_in_claude_code' } });
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
      interactive_chat: ['Yes', 'Yes'],
      phone_remote: ['Yes', 'Yes'],
      unattended_runs: ['Not yet', 'Yes'],
      nekko_tools: ['Not yet', 'Yes'],
      usage_limits: ['Yes', 'Yes'],
      model_routing: ['No', 'Yes'],
    });
    expect(t.columns.map((c) => c.id)).toEqual(['subscription', 'api']);
    expect(t.billedTo).toEqual(['Your Claude plan', 'Your API or cloud account, per token']);
  });
});

describe('claudeAccountCheck', () => {
  const personal = { label: 'Personal', email: 'me@example.com', orgId: 'o1', subscriptionType: 'max' };
  it('blocks the same login twice, whatever the case of the email', () => {
    const r = claudeAccountCheck({ email: 'ME@example.com', orgId: 'o1', subscriptionType: 'max' }, [personal]);
    expect(r.verdict).toBe('blocked');
    expect(r.sameAs).toBe('Personal');
  });
  it('asks before a second personal plan', () => {
    expect(claudeAccountCheck({ email: 'other@example.com', orgId: 'o2', subscriptionType: 'pro' }, [personal]).verdict).toBe('confirm');
  });
  it('allows an organization seat, or the same email in another organization', () => {
    expect(claudeAccountCheck({ email: 'me@work.com', orgId: 'o3', subscriptionType: 'team' }, [personal]).verdict).toBe('ok');
    expect(claudeAccountCheck({ email: 'me@example.com', orgId: 'o9', subscriptionType: 'team' }, [personal]).verdict).toBe('ok');
    expect(claudeAccountCheck({ email: 'me@example.com', subscriptionType: 'max' }, []).verdict).toBe('ok');
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
