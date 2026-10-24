import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, PrInfo, AgentWatchView } from '@nekko-agent/shared';
import { canOfferPrWatch, prWatchPrompt, unwatchedPrs } from './prWatchContinuation.js';
import { __setAgentWatches } from './agentWatches.js';
import { PrWatchContinuation } from './components/PrWatchContinuation.js';
const pr = { url: 'https://github.com/owner/repo/pull/42', state: 'open', number: 42 } as PrInfo;
const message = { id: 'reply', role: 'assistant', content: 'Done.' } as ChatMessage;
const watch = { id: 'watch', kind: 'pr', url: pr.url, status: 'active', deadlineAt: Date.now() + 3600000, nextPollAt: 0, failures: 0, pending: false } as AgentWatchView;
afterEach(() => __setAgentWatches('s', null));
describe('user PR watch continuation', () => {
  it('offers only after a settled assistant reply', () => {
    expect(canOfferPrWatch([message], false)).toBe(true);
    for (const m of [{ ...message, role: 'user' }, { ...message, interrupted: true }, { ...message, toolCalls: [{ id: 'x', name: 'bash', input: {} }] }, { ...message, content: '' }]) {
      expect(canOfferPrWatch([m as ChatMessage], false)).toBe(false);
    }
    expect(canOfferPrWatch([message], true)).toBe(false);
    expect(canOfferPrWatch([], false)).toBe(false);
  });
  it('excludes merged, closed and already watched PRs', () => {
    expect(unwatchedPrs([pr, { ...pr, state: 'merged' }, { ...pr, state: 'closed' }], [])).toEqual([pr]);
    expect(unwatchedPrs([pr], [watch])).toEqual([]);
    expect(unwatchedPrs([pr], [{ ...watch, status: 'cancelled' }])).toEqual([pr]);
  });
  it('requires normal checks and explicit successful watch registration', () => {
    const prompt = prWatchPrompt(pr.url);
    for (const text of [pr.url, 'Do not bypass', 'reviews', 'visual evidence', 'bounded deadline', 'successful registration', 'genuinely blocked']) expect(prompt).toContain(text);
  });
  it('does not start work merely by rendering the two options', () => {
    const send = vi.fn();
    const html = renderToStaticMarkup(<PrWatchContinuation sessionId="s" replyId="reply" prs={[pr]} eligible onContinue={send} />);
    expect(html).toContain('Watch CI and merge when passing');
    expect(html).toContain('Skip');
    expect(html).not.toContain('Watcher active');
    expect(send).not.toHaveBeenCalled();
  });
  it('shows real scheduler state, never an optimistic active claim', () => {
    __setAgentWatches('s', [watch]);
    const html = renderToStaticMarkup(<PrWatchContinuation sessionId="s" replyId="reply" prs={[pr]} eligible onContinue={vi.fn()} />);
    expect(html).toContain('Watcher active');
    expect(html).not.toContain('Watch CI and merge when passing');
  });
});
