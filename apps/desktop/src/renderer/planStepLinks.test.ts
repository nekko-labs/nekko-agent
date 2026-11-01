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

  it('puts task links and sub-agents on the step being worked when they appeared, earlier ones on the first step', () => {
    const issue = 'https://linear.app/nekko/issue/NEK-412/move-session-checks';
    const messages = [
      msg({ role: 'user', createdAt: 1, content: `Work on this Linear task: Move session checks\nLink: ${issue}.` }),
      msg({ createdAt: 10, toolCalls: [plan([{ title: 'Trace', status: 'active' }, { title: 'Fix' }, { title: 'Ship' }])] }),
      msg({ createdAt: 20, toolCalls: [plan([{ id: 'step_1', status: 'done' }, { id: 'step_2', status: 'active' }])] }),
      msg({ createdAt: 22, content: 'Filed https://github.com/o/r/issues/12 for the leftovers.' }),
      msg({ createdAt: 30, content: `Still ${issue}`, toolCalls: [plan([{ id: 'step_2', status: 'done' }])] }),
    ];
    const links = planStepLinks(messages, live, undefined, [{ id: 'early', createdAt: 5 }, { id: 'map', createdAt: 12 }, { id: 'routes', createdAt: 25 }, { id: 'late', createdAt: 40 }]);
    expect(links.get('live_0')?.projects).toEqual([{ url: issue, label: 'NEK-412' }]);
    // A link already shown on an earlier step is not repeated.
    expect(links.get('live_1')?.projects).toEqual([{ url: 'https://github.com/o/r/issues/12', label: 'o/r#12' }]);
    expect(links.get('live_0')?.subagents).toEqual(['early', 'map']);
    // Started after the last step finished: the last step worked.
    expect(links.get('live_1')?.subagents).toEqual(['routes', 'late']);
  });

  it('reads task keys from the tools people link', async () => {
    const { projectLinks } = await import('./planStepLinks.js');
    expect(projectLinks('see https://acme.atlassian.net/browse/OPS-7, https://trello.com/c/AbC123/9-x and https://example.com/x').map((l) => l.label)).toEqual(['OPS-7', 'Trello card']);
    expect(projectLinks('a PR is not a task: https://github.com/o/r/pull/7')).toEqual([]);
  });

  it('returns nothing without a plan', () => {
    expect(planStepLinks([msg({ content: '[x](file:///tmp/x.html)' })], undefined).size).toBe(0);
  });
});

describe('planStepLinks on a Claude Agent chat', () => {
  const ccPr = 'https://github.com/o/r/pull/9';
  const create = (id: string) => ({ id, name: 'Bash', input: { command: `gh pr create --title "Fix" --body "$(cat <<'EOF'\n## Summary\n- fixed it; done\nEOF\n)"` } });

  it('places a PR Claude Code opened on the task it had in progress', () => {
    const messages = [
      msg({ toolCalls: [{ id: 't1', name: 'TaskCreate', input: { subject: 'Fix', description: '' } }] }),
      msg({ role: 'tool', toolResult: { toolCallId: 't1', output: 'Task #1 created successfully: Fix' } }),
      msg({ toolCalls: [{ id: 't2', name: 'TaskUpdate', input: { taskId: '1', status: 'in_progress' } }, create('gh')] }),
      msg({ role: 'tool', toolResult: { toolCallId: 'gh', output: ccPr } }),
    ];
    expect(planStepLinks(messages, live).get('live_1')?.prs).toEqual([ccPr]);
  });

  it('follows TodoWrite to the step in progress', () => {
    const messages = [
      msg({ toolCalls: [{ id: 'tw', name: 'TodoWrite', input: { todos: [{ content: 'Trace', status: 'completed' }, { content: 'Ship', status: 'in_progress' }] } }, create('gh')] }),
      msg({ role: 'tool', toolResult: { toolCallId: 'gh', output: ccPr } }),
    ];
    expect(planStepLinks(messages, live).get('live_2')?.prs).toEqual([ccPr]);
  });

  it('puts the PR on the Ship step of an activity plan', async () => {
    const { claudeCodeActivityPlan } = await import('./claudeAgentPlan.js');
    const messages = [
      msg({ role: 'user', content: 'Fix the parser' }),
      msg({ toolCalls: [{ id: 'r', name: 'Read', input: { file_path: 'a.ts' } }, { id: 'e', name: 'Edit', input: {} }] }),
      msg({ toolCalls: [create('gh')] }),
      msg({ role: 'tool', toolResult: { toolCallId: 'gh', output: ccPr } }),
    ];
    const plan = claudeCodeActivityPlan(messages, false)!;
    expect(plan.map(s => s.id)).toEqual(['phase:sent', 'phase:explore', 'phase:build', 'phase:ship']);
    const links = planStepLinks(messages, plan);
    expect(links.get('phase:ship')?.prs).toEqual([ccPr]);
    expect(links.has('phase:build')).toBe(false);
  });
});
