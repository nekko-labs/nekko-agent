import { describe, expect, it } from 'vitest';
import type { ChatMessage, PlanStep, ProviderConfig, Session } from '@nekko-agent/shared';
import { claudeCodeTurnPlan, sheetPlan } from './claudeAgentPlan.js';

const user = (id: string, content: string): ChatMessage => ({ id, role: 'user', content, createdAt: 0 });
const providers = [{ id: 'cc', kind: 'claude-code' }, { id: 'oa', kind: 'openai' }] as ProviderConfig[];
const session = (patch: Partial<Session>) => ({ id: 's', providerId: 'cc', messages: [user('a', 'Fix it')], ...patch }) as Session;

describe('claudeAgentPlan', () => {
  it('makes one step per request, the newest active while Claude Code works', () => {
    const messages = [user('a', '\n  Fix the parser\nmore'), user('b', '   '), user('c', 'Ship it')];
    expect(claudeCodeTurnPlan(messages, false).map(s => [s.id, s.title, s.status])).toEqual([
      ['turn:a', 'Ask Claude Code: Fix the parser', 'done'],
      ['turn:c', 'Ask Claude Code: Ship it', 'done'],
    ]);
    expect(claudeCodeTurnPlan(messages, true).at(-1)?.status).toBe('active');
    expect(claudeCodeTurnPlan(Array.from({ length: 12 }, (_, i) => user(String(i), `ask ${i}`)), false)).toHaveLength(8);
  });

  it('shows the chat\'s own plan first, turns only on a Claude Agent chat', () => {
    const own: PlanStep[] = [{ id: 'todo_1', title: 'Fix', status: 'active', createdAt: 0, updatedAt: 0 }];
    expect(sheetPlan(session({ agentPlan: own }), providers, false)).toBe(own);
    expect(sheetPlan(session({}), providers, false)?.[0].id).toBe('turn:a');
    expect(sheetPlan(session({ providerId: 'oa' }), providers, false)).toBeUndefined();
    expect(sheetPlan(session({ messages: [] }), providers, false)).toBeUndefined();
  });
});
