import { ActiveWatchChips } from './components/ActiveWatchChips.js';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, PrInfo, AgentWatchView } from '@nekko-agent/shared';
import { canOfferPrWatch, markPrWatchAnswered, prWatchAnswered, prWatchPrompt, unwatchedPrs } from './prWatchContinuation.js';
import { __setAgentWatches } from './agentWatches.js';
import { PrWatchContinuation } from './components/PrWatchContinuation.js';
const pr = { url: 'https://github.com/owner/repo/pull/42', state: 'open', number: 42 } as PrInfo;
const message = { id: 'reply', role: 'assistant', content: 'Done.' } as ChatMessage;
const watch = { id: 'watch', kind: 'pr', url: pr.url, status: 'active', deadlineAt: Date.now() + 3600000, nextPollAt: 0, failures: 0, pending: false } as AgentWatchView;
const store = new Map<string, string>();
vi.stubGlobal('window', { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } } });
afterEach(() => { __setAgentWatches('s', null); store.clear(); });
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
    const html = renderToStaticMarkup(<PrWatchContinuation sessionId="s" prs={[pr]} eligible onContinue={send} />);
    expect(html).toContain('Watch CI and merge when passing');
    expect(html).toContain('Skip');
    expect(html).not.toContain('Watcher active');
    expect(send).not.toHaveBeenCalled();
  });
  it('shows real scheduler state, never an optimistic active claim', () => {
    __setAgentWatches('s', [watch]);
    const html = renderToStaticMarkup(<PrWatchContinuation sessionId="s" prs={[pr]} eligible onContinue={vi.fn()} />);
    expect(html).toBe('');
    expect(renderToStaticMarkup(<ActiveWatchChips sessionId="s" />)).toContain('PR watcher');
    expect(html).not.toContain('Watch CI and merge when passing');
  });
  it('asks once per chat and PR, whatever replies or callbacks come after', () => {
    expect(prWatchAnswered('s', pr.url)).toBe(false);
    markPrWatchAnswered('s', pr.url);
    expect(prWatchAnswered('s', pr.url)).toBe(true);
    // No active watch (the watcher may be a Claude Code background task), yet the answer holds.
    expect(renderToStaticMarkup(<PrWatchContinuation sessionId="s" prs={[pr]} eligible onContinue={vi.fn()} />)).toBe('');
    // Another chat, or another PR in this chat, is still asked.
    expect(renderToStaticMarkup(<PrWatchContinuation sessionId="t" prs={[pr]} eligible onContinue={vi.fn()} />)).toContain('Watch CI and merge when passing');
    const other = { ...pr, url: 'https://github.com/owner/repo/pull/43', number: 43 };
    expect(renderToStaticMarkup(<PrWatchContinuation sessionId="s" prs={[pr, other]} eligible onContinue={vi.fn()} />)).toContain('PR #43 is still open.');
  });
});
