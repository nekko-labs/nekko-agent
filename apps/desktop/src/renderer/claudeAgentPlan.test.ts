import { describe, expect, it } from 'vitest';
import type { ChatMessage, PlanStep, ProviderConfig, Session, ToolCall } from '@nekko-agent/shared';
import { claudeCodeActivityPlan, claudeCodeOwnPlan, claudeCodePhase, sheetPlan } from './claudeAgentPlan.js';

let seq = 0;
const user = (content: string): ChatMessage => ({ id: 'u' + seq++, role: 'user', content, createdAt: seq });
const said = (calls: ToolCall[] = [], content = ''): ChatMessage => ({ id: 'a' + seq++, role: 'assistant', content, toolCalls: calls, createdAt: seq });
const result = (toolCallId: string, output: string, isError = false): ChatMessage => ({ id: 't' + seq++, role: 'tool', content: '', toolResult: { toolCallId, output, isError }, createdAt: seq });
const call = (name: string, input: Record<string, unknown> = {}): ToolCall => ({ id: 'c' + seq++, name, input });
const bash = (command: string) => call('Bash', { command });
const rows = (plan?: PlanStep[]) => plan?.map(s => [s.id, s.status]);

describe('claudeCodePhase', () => {
  it('reads the phase from the tool, and for Bash from its command', () => {
    expect(claudeCodePhase(call('Grep'))).toBe('explore');
    expect(claudeCodePhase(call('Edit'))).toBe('build');
    expect(claudeCodePhase(bash('git log --oneline -5'))).toBe('explore');
    expect(claudeCodePhase(bash('npx vitest run src/a.test.ts'))).toBe('verify');
    expect(claudeCodePhase(bash('cargo clippy -p nekkod'))).toBe('verify');
    expect(claudeCodePhase(bash('git add -A && git commit -m x'))).toBe('build');
    expect(claudeCodePhase(bash('git push -u origin fix && gh pr create --fill'))).toBe('ship');
    expect(claudeCodePhase(call('TaskCreate'))).toBeNull();
    expect(claudeCodePhase(call('Agent'))).toBeNull();
  });
});

describe('claudeCodeActivityPlan', () => {
  it('follows the latest request through the loop while Claude Code works', () => {
    const grep = call('Grep'), read = call('Read'), edit = call('Edit');
    const messages = [user('Old ask'), said([call('Edit')]), user('nekko agent\n- fix the composer text'), said([grep, read]), said([edit])];
    expect(rows(claudeCodeActivityPlan(messages, true))).toEqual([
      ['phase:sent', 'done'], ['phase:explore', 'done'], ['phase:build', 'active'], ['phase:verify', 'pending'], ['phase:ship', 'pending'],
    ]);
    const plan = claudeCodeActivityPlan(messages, true)!;
    expect(plan[0].note).toBe('nekko agent');
    expect(plan[1]).toMatchObject({ kind: 'explore', note: '2 reads and searches' });
    expect(plan[2]).toMatchObject({ kind: 'build', note: '1 edit' });
  });

  it('starts with the request on its way, and keeps only the phases a finished turn touched', () => {
    expect(rows(claudeCodeActivityPlan([user('Fix it')], true))).toEqual([
      ['phase:sent', 'active'], ['phase:explore', 'pending'], ['phase:build', 'pending'], ['phase:verify', 'pending'], ['phase:ship', 'pending'],
    ]);
    expect(rows(claudeCodeActivityPlan([user('Fix it'), said([], 'Looking.')], true))?.[1]).toEqual(['phase:explore', 'active']);
    const done = [user('Fix it'), said([call('Read'), call('Edit'), bash('npm test'), bash('gh pr create --fill')])];
    expect(rows(claudeCodeActivityPlan(done, false))).toEqual([
      ['phase:sent', 'done'], ['phase:explore', 'done'], ['phase:build', 'done'], ['phase:verify', 'done'], ['phase:ship', 'done'],
    ]);
    expect(rows(claudeCodeActivityPlan([user('Fix it'), said([call('Read'), call('Edit')])], false))).toEqual([
      ['phase:sent', 'done'], ['phase:explore', 'done'], ['phase:build', 'done'],
    ]);
  });

  it('shows no plan for a request Claude Code only answered', () => {
    expect(claudeCodeActivityPlan([user('What is this repo?'), said([], 'A desktop app.')], false)).toBeUndefined();
    expect(claudeCodeActivityPlan([], true)).toBeUndefined();
  });
});

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

  it("shows the chat's own plan first, then Claude Code's rebuilt plan, then its activity", () => {
    const own: PlanStep[] = [{ id: 'todo_1', title: 'Fix', status: 'active', createdAt: 0, updatedAt: 0 }];
    expect(sheetPlan(session({ agentPlan: own }), providers, false)).toBe(own);
    const todo = call('TodoWrite', { todos: [{ content: 'Trace', status: 'in_progress' }] });
    expect(sheetPlan(session({ messages: [user('go'), said([todo]), result(todo.id, 'ok')] }), providers, false)?.[0].id).toBe('todo_1');
    expect(sheetPlan(session({}), providers, false)?.map(s => s.id)).toEqual(['phase:sent', 'phase:explore']);
    expect(sheetPlan(session({ providerId: 'oa' }), providers, true)).toBeUndefined();
  });
});
