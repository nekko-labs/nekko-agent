import { describe, expect, it } from 'vitest';
import type { ChatMessage, PlanStep, ProviderConfig, Session, ToolCall } from '@nekko-agent/shared';
import { claudeCodeOwnPlan, sheetPlan } from './claudeAgentPlan.js';

let seq = 0;
const user = (content: string): ChatMessage => ({ id: 'u' + seq++, role: 'user', content, createdAt: seq });
const said = (calls: ToolCall[] = [], content = ''): ChatMessage => ({ id: 'a' + seq++, role: 'assistant', content, toolCalls: calls, createdAt: seq });
const result = (toolCallId: string, output: string, isError = false): ChatMessage => ({ id: 't' + seq++, role: 'tool', content: '', toolResult: { toolCallId, output, isError }, createdAt: seq });
const call = (name: string, input: Record<string, unknown> = {}): ToolCall => ({ id: 'c' + seq++, name, input });

describe('claudeCodeOwnPlan', () => {
  it('rebuilds Claude Code tasks from TaskCreate and TaskUpdate, as nekkod keeps them', () => {
    const a = call('TaskCreate', { subject: 'Add pupilOffset prop', description: '\nIn Mascot.tsx, add it.\nMore' });
    const b = call('TaskCreate', { subject: 'Mount ChatMascot', description: '' });
    const failed = call('TaskCreate', { subject: 'Never made' });
    const start = call('TaskUpdate', { taskId: '1', status: 'in_progress' });
    const drop = call('TaskUpdate', { taskId: '2', status: 'deleted' });
    const messages = [user('go'), said([a]), result(a.id, 'Task #1 created successfully: Add pupilOffset prop'), said([b]), result(b.id, 'Task #2 created successfully: Mount ChatMascot'),
      said([failed]), result(failed.id, 'error', true), said([start]), result(start.id, 'Updated task #1 status')];
    const plan = claudeCodeOwnPlan(messages)!;
    expect(plan.map(s => [s.id, s.title, s.status, s.note])).toEqual([
      ['task_1', 'Add pupilOffset prop', 'active', 'In Mascot.tsx, add it.'],
      ['task_2', 'Mount ChatMascot', 'pending', undefined],
    ]);
    expect(claudeCodeOwnPlan([...messages, said([drop]), result(drop.id, 'Updated task #2 deleted')])?.map(s => s.id)).toEqual(['task_1']);
  });

  it('takes the latest TodoWrite list whole', () => {
    const first = call('TodoWrite', { todos: [{ content: 'Old', status: 'completed' }] });
    const next = call('TodoWrite', { todos: [{ content: 'Trace', status: 'completed' }, { content: 'Fix', status: 'in_progress' }, { content: ' ', status: 'pending' }] });
    const plan = claudeCodeOwnPlan([said([first]), result(first.id, 'ok'), said([next]), result(next.id, 'ok')]);
    expect(plan?.map(s => [s.id, s.title, s.status])).toEqual([['todo_1', 'Trace', 'done'], ['todo_2', 'Fix', 'active']]);
    expect(claudeCodeOwnPlan([said([call('Read')])])).toBeUndefined();
  });
});

describe('sheetPlan', () => {
  const providers = [{ id: 'cc', kind: 'claude-code' }, { id: 'oa', kind: 'openai' }] as ProviderConfig[];
  const session = (patch: Partial<Session>) => ({ id: 's', providerId: 'cc', messages: [user('Fix it'), said([call('Read')])], ...patch }) as Session;

  it("shows the chat's own plan first, then Claude Code's rebuilt plan, and none when it wrote none", () => {
    const own: PlanStep[] = [{ id: 'todo_1', title: 'Fix', status: 'active', createdAt: 0, updatedAt: 0 }];
    expect(sheetPlan(session({ agentPlan: own }), providers)).toBe(own);
    const todo = call('TodoWrite', { todos: [{ content: 'Trace', status: 'in_progress' }] });
    expect(sheetPlan(session({ messages: [user('go'), said([todo]), result(todo.id, 'ok')] }), providers)?.[0].id).toBe('todo_1');
    expect(sheetPlan(session({}), providers)).toBeUndefined();
    expect(sheetPlan(session({ providerId: 'oa' }), providers)).toBeUndefined();
  });
});
