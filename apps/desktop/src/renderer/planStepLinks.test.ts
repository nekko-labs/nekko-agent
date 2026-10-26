import { describe, expect, it } from 'vitest';
import type { ChatMessage, PlanStep } from '@nekko-agent/shared';
import { planStepLinks } from './planStepLinks.js';

const plan = (steps: unknown[]) => ({ id: 'u' + Math.random(), name: 'update_plan', input: { steps } });
const msg = (patch: Partial<ChatMessage>): ChatMessage => ({ id: String(Math.random()), role: 'assistant', content: '', createdAt: 0, ...patch });
const live: PlanStep[] = ['Trace', 'Fix', 'Ship'].map((title, i) => ({ id: 'live_' + i, title, status: 'pending', createdAt: 0, updatedAt: 0 }));
const pr = 'https://github.com/o/r/pull/7';

describe('planStepLinks', () => {
  it('gives a PR and a linked file to the step active when they appeared', () => {
    const messages = [
      msg({ content: 'See [early](file:///tmp/early.html).', toolCalls: [plan([{ title: 'Trace', status: 'active' }, { title: 'Fix' }, { title: 'Ship' }])] }),
      msg({ content: 'The [mockup](file:///tmp/mockup.html).', toolCalls: [plan([{ id: 'step_1', status: 'done' }, { id: 'step_2', status: 'active' }]), { id: 'gh', name: 'bash', input: { command: 'gh pr create --fill' } }] }),
      msg({ role: 'tool', toolResult: { toolCallId: 'gh', output: pr } }),
    ];
    const links = planStepLinks(messages, live);
    // Text before the first plan has no step; text before a plan update belongs to the step it closes.
    expect(links.get('live_0')?.artifacts.map(a => a.filename)).toEqual(['mockup.html']);
    expect(links.get('live_1')?.prs).toEqual([pr]);
    expect(links.has('live_2')).toBe(false);
  });

  it('ignores PR URLs the agent only mentioned, not created', () => {
    const messages = [
      msg({ toolCalls: [plan([{ title: 'Trace', status: 'active' }]), { id: 'cat', name: 'bash', input: { command: 'cat notes.md' } }] }),
      msg({ role: 'tool', toolResult: { toolCallId: 'cat', output: pr } }),
    ];
    expect(planStepLinks(messages, live).size).toBe(0);
  });

  it('returns nothing without a plan', () => {
    expect(planStepLinks([msg({ content: '[x](file:///tmp/x.html)' })], undefined).size).toBe(0);
  });
});
