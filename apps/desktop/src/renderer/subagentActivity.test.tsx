import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import type { PendingInput, SessionSummary, ToolCall } from '@nekko-agent/shared';
import { activitySentence, childActivity, compactSentence, delegationActivity, delegationChild, foldSubagentActivity, startSubagentActivity } from './subagentActivity.js';
import { applyEvent, __resetLiveRuns } from './liveRuns.js';
const child = { id: 'c', parentSessionId: 'p', title: 'Inspect', createdAt: 101, stalled: false } as SessionSummary;
vi.mock('./store.js', () => ({ useStore: (select: (state: unknown) => unknown) => select({ sessions: [child], settings: {}, openChatPane: () => {} }) }));
import { PlanRail } from './components/PlanRail.js';
import { ActivityGroup } from './components/agent-console/ActivityGroup.js';
import { SubagentParentContext } from './components/agent-console/SubagentCue.js';
import { ToolCard } from './components/agent-console/ToolCard.js';
import { RowKeyContext, RowMemoryContext } from './components/agent-console/rowState.js';
const call: ToolCall = { id: 'spawn', name: 'spawn_agent', input: { title: 'Inspect', task: 'Inspect the files. PRIVATE PROMPT '.repeat(1000) } };
beforeEach(() => { vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {}); __resetLiveRuns(); });

it('keeps chat and rail identical across working, waiting, failure and completion events', () => {
  foldSubagentActivity({ type: 'tool_call', sessionId: 'p', call }, 100);
  const check = () => {
    const sentence = activitySentence(childActivity(child));
    const rail = renderToStaticMarkup(<PlanRail sessionId="p" session={null} streaming={false} />);
    const chat = renderToStaticMarkup(<SubagentParentContext.Provider value={[child]}><ActivityGroup items={[{ kind: 'tool', call }]} streaming /></SubagentParentContext.Provider>);
    expect(rail).toContain(sentence);
    expect(chat).toContain(sentence);
    expect(chat).toContain('aria-expanded="false"');
    expect(chat).not.toContain('PRIVATE PROMPT');
    return childActivity(child).status;
  };
  applyEvent({ type: 'tool_call', sessionId: 'c', call: { id: 'read', name: 'read_file', input: { path: 'src/main.ts' } } });
  expect(check()).toBe('working');
  applyEvent({ type: 'tool_approval_required', sessionId: 'c', call, reason: 'approval', severity: 'low' });
  expect(check()).toBe('waiting');
  applyEvent({ type: 'tool_result', sessionId: 'c', result: { toolCallId: 'read', output: 'ok' } });
  expect(check()).toBe('working');
  expect(delegationActivity(call, child, { toolCallId: 'spawn', output: 'returned' }).status).toBe('working');
  applyEvent({ type: 'error', sessionId: 'c', message: 'Provider unavailable.' });
  expect(check()).toBe('failed');
  applyEvent({ type: 'error', sessionId: 'c', message: 'Stopped' });
  expect(check()).toBe('stopped');
  applyEvent({ type: 'text', sessionId: 'c', delta: 'Inspecting again.' });
  expect(check()).toBe('working');
  applyEvent({ type: 'done', sessionId: 'c', messageId: 'm', stop: 'complete' });
  expect(check()).toBe('completed');
});

it('reports questions, retries, explicit stops and loop stops honestly', () => {
  applyEvent({ type: 'question', sessionId: 'c', request: {} as never });
  expect(childActivity(child).status).toBe('waiting');
  applyEvent({ type: 'question_resolved', sessionId: 'c', callId: 'q' });
  expect(childActivity(child).status).toBe('working');
  applyEvent({ type: 'retry', sessionId: 'c', attempt: 1, maxAttempts: 3, delayMs: 10, reason: 'busy' });
  expect(childActivity(child).status).toBe('waiting');
  applyEvent({ type: 'error', sessionId: 'c', message: 'Aborted' });
  expect(childActivity(child).status).toBe('stopped');
  applyEvent({ type: 'error', sessionId: 'c', message: 'Stopped' });
  expect(childActivity(child)).toEqual({ status: 'stopped', detail: 'The run was stopped.' });
  applyEvent({ type: 'done', sessionId: 'c', messageId: 'm', stop: 'loop' });
  expect(childActivity(child).status).toBe('stopped');
  expect(childActivity(child, true, { approval: {} } as PendingInput).status).toBe('waiting');
});

it('does not guess completion or associate ambiguous children', () => {
  expect(childActivity({ ...child, lastReplyText: 'Earlier answer' }).status).toBe('waiting');
  expect(delegationActivity(call, undefined, { toolCallId: 'spawn', output: 'returned' }).status).toBe('waiting');
  expect(delegationActivity(call, undefined, { toolCallId: 'spawn', output: 'Invalid provider', isError: true }).status).toBe('failed');
  expect(delegationChild(call, [child, { ...child, id: 'other' }])).toBeUndefined();
});

it('falls back to the title for missing or blank tasks', () => {
  for (const task of [undefined, '', '  \n\t']) {
    expect(delegationActivity({ ...call, input: { title: 'Integration checks', task } })).toEqual({ status: 'waiting', detail: 'Integration checks' });
  }
  expect(activitySentence(delegationActivity(call))).toBe('Subagent waiting · Inspect the files.');
});

it('associates only a unique observed child in the parent and spawn time scope', () => {
  expect(delegationChild(call, [child])).toBeUndefined();
  foldSubagentActivity({ type: 'tool_call', sessionId: 'p', call }, 100);
  expect(delegationChild(call, [{ ...child, createdAt: 99 }])).toBeUndefined();
  expect(delegationChild(call, [{ ...child, parentSessionId: 'elsewhere' }])).toBeUndefined();
  expect(delegationChild(call, [child, { ...child, id: 'duplicate' }])).toBeUndefined();
  expect(delegationChild(call, [child, { ...child, id: 'unrelated', parentSessionId: 'elsewhere' }])).toBe(child);
  expect(delegationChild(call, [child, { ...child, id: 'later', createdAt: 200 }])).toBe(child);
});

it('refuses concurrent ambiguous scopes and children outside the completed spawn window', () => {
  foldSubagentActivity({ type: 'tool_call', sessionId: 'p', call }, 100);
  foldSubagentActivity({ type: 'tool_result', sessionId: 'p', result: { toolCallId: call.id, output: 'returned' } }, 110);
  expect(delegationChild(call, [{ ...child, createdAt: 111 }])).toBeUndefined();
  foldSubagentActivity({ type: 'tool_call', sessionId: 'p', call: { ...call, id: 'concurrent' } }, 100);
  expect(delegationChild(call, [child])).toBeUndefined();
});

it('preserves failure and abort when done closes the same turn, then resets on new activity', () => {
  for (const message of ['Provider unavailable.', 'Aborted', 'Stopped']) {
    __resetLiveRuns();
    applyEvent({ type: 'error', sessionId: 'c', message });
    const failed = childActivity(child);
    applyEvent({ type: 'done', sessionId: 'c', messageId: 'm', stop: 'complete' });
    expect(childActivity(child)).toEqual(failed);
    expect(childActivity(child, true).status).toBe('working');
    // Usage may be the first event of a fresh run, before any visible activity.
    applyEvent({ type: 'usage', sessionId: 'c', inputTokens: 1, outputTokens: 1 });
    expect(childActivity(child).status).toBe('working');
    applyEvent({ type: 'done', sessionId: 'c', messageId: 'next', stop: 'complete' });
    expect(childActivity(child).status).toBe('completed');
  }
});

it('keeps sequential same-title calls attached to their own child even before the new child appears', () => {
  foldSubagentActivity({ type: 'tool_call', sessionId: 'p', call }, 100);
  foldSubagentActivity({ type: 'tool_result', sessionId: 'p', result: { toolCallId: call.id, output: 'returned' } }, 110);
  const nextCall = { ...call, id: 'next-spawn' };
  foldSubagentActivity({ type: 'tool_call', sessionId: 'p', call: nextCall }, 120);
  expect(delegationChild(nextCall, [child])).toBeUndefined();
  const nextChild = { ...child, id: 'next-child', createdAt: 121 };
  expect(delegationChild(nextCall, [child, nextChild])).toBe(nextChild);
  expect(delegationChild(call, [child, nextChild])).toBe(child);
});

it('restarts terminal activity while retaining live waiting and pending-input states', () => {
  applyEvent({ type: 'done', sessionId: 'c', messageId: 'm', stop: 'complete' });
  expect(childActivity(child, true).status).toBe('working');
  startSubagentActivity('c');
  expect(childActivity(child).status).toBe('working');
  applyEvent({ type: 'retry', sessionId: 'c', attempt: 1, maxAttempts: 3, delayMs: 10, reason: 'busy' });
  expect(childActivity(child, true).status).toBe('waiting');
  expect(childActivity(child, true, { question: {} } as PendingInput).detail).toBe('Waiting for your answer.');
});

it('preserves excerpt whitespace, sentence lookahead and truncation boundaries', () => {
  expect(compactSentence('  \u0000\tHello\u00a0 world!\nMore')).toBe('Hello world!');
  expect(compactSentence('abc.def xyz', 6)).toBe('abc.d…');
  expect(compactSentence('abcd. more', 5)).toBe('abcd.');
  expect(compactSentence('abcd.! more', 5)).toBe('abcd…');
  expect(compactSentence('abc  d', 4)).toBe('abc…');
  expect(compactSentence('猫\u2003😀\ufeffok. more')).toBe('猫 😀 ok.');
  expect(compactSentence(' '.repeat(1999) + 'xTAIL')).toBe('x');
});

it('bounds safe plain-text summaries and long prompt/result collapsed markup', () => {
  expect(compactSentence('One sentence. SECRET NEXT')).toBe('One sentence.');
  expect(compactSentence('x'.repeat(10000)).length).toBeLessThanOrEqual(140);
  expect(compactSentence('line\n\ttext')).toBe('line text');
  const result = { toolCallId: 'spawn', output: 'PRIVATE RESULT '.repeat(10000) };
  const chat = renderToStaticMarkup(<ActivityGroup items={[{ kind: 'tool', call, result }]} streaming />);
  expect(chat).not.toContain('PRIVATE RESULT');
  expect(chat).not.toContain('PRIVATE PROMPT');
  expect(chat.length).toBeLessThan(3000);
  const tool = renderToStaticMarkup(<ToolCard call={call} />);
  expect(tool).toContain('aria-expanded="false"');
  expect(tool).not.toContain('PRIVATE PROMPT');
  const memory = new Map<string, unknown>([['row:group-open', true], ['row:step-1-open', true]]);
  const expanded = renderToStaticMarkup(<RowMemoryContext.Provider value={memory}><RowKeyContext.Provider value="row"><ActivityGroup items={[{ kind: 'tool', call, result }]} streaming /></RowKeyContext.Provider></RowMemoryContext.Provider>);
  expect(expanded).toContain('PRIVATE PROMPT');
  expect(expanded).toContain('PRIVATE RESULT');
  expect(expanded).toContain('max-h-60 overflow-auto');
});
