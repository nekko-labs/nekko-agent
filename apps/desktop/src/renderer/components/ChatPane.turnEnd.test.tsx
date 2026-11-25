// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AgentEvent, Session, SessionSummary } from '@nekko-agent/shared';
import { useStore } from '../store.js';
import { __resetSessionCache } from '../sessionCache.js';
import { ChatPane } from './ChatPane.js';
import { __resetLiveRuns, applyEvent } from '../liveRuns.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no layout: stand-ins for what the pane measures with.
class Observer { observe() {} unobserve() {} disconnect() {} }
vi.stubGlobal('ResizeObserver', Observer);
vi.stubGlobal('IntersectionObserver', Observer);
window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as never;
(SVGElement.prototype as unknown as Record<string, unknown>).pauseAnimations ??= () => {};
(SVGElement.prototype as unknown as Record<string, unknown>).unpauseAnimations ??= () => {};
(SVGElement.prototype as unknown as Record<string, unknown>).getCurrentTime ??= () => 0;
(SVGElement.prototype as unknown as Record<string, unknown>).setCurrentTime ??= () => {};
Element.prototype.scrollTo ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

const session = (extra: Partial<Session> = {}): Session => ({
  id: 'chat-1', title: 'Chat', createdAt: 0, updatedAt: 1, providerId: 'p', modelId: 'm',
  messages: [{ id: 'u1', role: 'user', content: 'hi', createdAt: 0 }, { id: 'a1', role: 'assistant', content: 'hello', createdAt: 0 }],
  ...extra,
}) as Session;
const summaryOf = (s: Session, extra: Record<string, unknown> = {}): SessionSummary => {
  const { messages, ...rest } = s;
  return { ...rest, messageCount: messages.length, exchangeCount: messages.length, transcriptTokens: 1, stalled: false, recentTurns: [], prUrls: [], imageCount: 0, ...extra } as unknown as SessionSummary;
};

let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; __resetSessionCache(); __resetLiveRuns(); });

async function mountPane(stored: { current: Session }, summaries: () => SessionSummary[]) {
  const listeners = new Set<(e: AgentEvent) => void>();
  const calls = { getSession: 0, suggestReplies: 0, listSessionSummaries: 0, nextAgentWatchAt: 0 };
  const bridge = new Proxy({
    getSession: async () => { calls.getSession++; return structuredClone(stored.current); },
    suggestReplies: async () => { calls.suggestReplies++; return { next: 'Next', options: ['Go on'] }; },
    listSessionSummaries: async () => { calls.listSessionSummaries++; return summaries(); },
    onAgentEvent: (fn: (e: AgentEvent) => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    onRunOrphaned: () => () => {},
    nextAgentWatchAt: async () => { calls.nextAgentWatchAt++; return null; },
    listAgentWatches: async () => [],
    getGitStatus: async () => ({ repo: false }),
  } as Record<string, unknown>, { get: (t, k: string) => (k in t ? t[k] : (k.startsWith('on') ? () => () => {} : async () => null)) });
  (window as unknown as { nekko: unknown }).nekko = bridge;
  useStore.setState({ providers: [{ id: 'p', name: 'Local', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1', enabled: true }] as never, models: [{ id: 'm', name: 'm', providerId: 'p' }] as never, sessions: summaries() });
  root = createRoot(document.createElement('div'));
  await act(async () => { root!.render(<ChatPane sessionId="chat-1" />); });
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
  calls.getSession = 0; calls.suggestReplies = 0; calls.listSessionSummaries = 0; calls.nextAgentWatchAt = 0;
  // The app folds every event into the live runs before any pane hears it.
  const emit = (e: AgentEvent) => act(async () => { applyEvent(e); for (const fn of [...listeners]) fn(e); await new Promise((r) => setTimeout(r, 50)); });
  return { calls, emit };
}

describe('ChatPane at the end of a turn', () => {
  it('reads the transcript once, and suggestions use it', async () => {
    const stored = { current: session() };
    const { calls, emit } = await mountPane(stored, () => [summaryOf(stored.current)]);
    await emit({ type: 'done', sessionId: 'chat-1', messageId: 'a1' } as AgentEvent);
    console.log('RESULT turn end', JSON.stringify(calls));
    expect(calls.getSession).toBe(1);
    expect(calls.suggestReplies).toBe(1);
  });

  it('updates the record from the summary when only the record changed, and reads the transcript when it did not', async () => {
    const stored = { current: session() };
    let titled = 'Chat';
    const { calls, emit } = await mountPane(stored, () => [summaryOf({ ...stored.current, title: titled })]);
    titled = 'A fresh title';
    await emit({ type: 'session_meta', sessionId: 'chat-1' } as AgentEvent);
    console.log('RESULT session_meta same transcript', JSON.stringify(calls));
    expect(calls.getSession).toBe(0);
    expect(calls.listSessionSummaries).toBe(1);
    stored.current = session({ messages: [...stored.current.messages, { id: 'a2', role: 'assistant', content: 'more', createdAt: 1 }] });
    calls.getSession = 0;
    await emit({ type: 'session_meta', sessionId: 'chat-1' } as AgentEvent);
    console.log('RESULT session_meta new messages', JSON.stringify(calls));
    expect(calls.getSession).toBe(1);
  });

  it('reads the next wake time on watch events, not after every tool result', async () => {
    const stored = { current: session() };
    const { calls, emit } = await mountPane(stored, () => [summaryOf(stored.current)]);
    await emit({ type: 'text', sessionId: 'chat-1', delta: 'Working' } as AgentEvent);
    calls.nextAgentWatchAt = 0;
    for (let i = 0; i < 20; i++) {
      await emit({ type: 'tool_call', sessionId: 'chat-1', call: { id: `c${i}`, name: 'shell', input: {} } } as AgentEvent);
      await emit({ type: 'tool_result', sessionId: 'chat-1', result: { toolCallId: `c${i}`, output: '', isError: false } } as AgentEvent);
    }
    console.log('RESULT wake reads over 20 shell tool results', calls.nextAgentWatchAt);
    expect(calls.nextAgentWatchAt).toBe(0);
    await emit({ type: 'tool_call', sessionId: 'chat-1', call: { id: 'w', name: 'agent_watch', input: {} } } as AgentEvent);
    await emit({ type: 'tool_result', sessionId: 'chat-1', result: { toolCallId: 'w', output: '', isError: false } } as AgentEvent);
    expect(calls.nextAgentWatchAt).toBe(1);
  });
});
