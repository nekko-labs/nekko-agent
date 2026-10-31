import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.hoisted(() => { Object.assign(globalThis, { window: {}, localStorage: { getItem: () => null } }); });
vi.mock('../../store.js', async (original) => {
  const actual = await original<typeof import('../../store.js')>();
  return { ...actual, useStore: Object.assign((selector: (s: ReturnType<typeof actual.useStore.getState>) => unknown) => selector(actual.useStore.getState()), actual.useStore) };
});
import type { ChatMessage, TurnStats } from '@nekko-agent/shared';
import { TurnStatsLine, turnStatsParts } from './TurnStatsLine.js';
import { MessageBubble } from './MessageBubble.js';
import { ModelPicker } from './ModelPicker.js';
import { toTranscriptRows } from './transcript.js';

const stats: TurnStats = {
  providerId: 'chatgpt', modelId: 'gpt-6.1-sol', effort: 'high',
  inputTokens: 1500, cacheReadTokens: 12_000, outputTokens: 640, outputMs: 8000, wallMs: 21_400, calls: 3, steps: 2, stop: 'complete',
};

describe('reply stats in the transcript', () => {
  it('names the model and effort and keeps the numbers', () => {
    expect(turnStatsParts(stats, { model: () => 'GPT Sol', provider: () => 'ChatGPT' })).toEqual([
      'GPT Sol · ChatGPT', 'High effort', '14k in', '640 out', '80 tok/s', '21s',
    ]);
    const html = renderToStaticMarkup(<TurnStatsLine stats={stats} />);
    expect(html).toContain('data-turn-stats');
    expect(html).toContain('gpt-6.1-sol');
    expect(html).toContain('12,000 cache read');
    expect(html).not.toContain('Reply stats');
  });

  it('says what code mode saved, and spells the estimate out on hover', () => {
    const codeMode = { toolsWrapped: 42, schemaTokensPerCall: 3_100, schemaTokensSaved: 9_300, resultTokensSaved: 4_800, searchTokens: 260, tokensSaved: 13_840, runs: 2, toolCalls: 7 };
    expect(turnStatsParts({ ...stats, codeMode })).toContain('≈14k saved by code mode');
    const html = renderToStaticMarkup(<TurnStatsLine stats={{ ...stats, codeMode }} />);
    expect(html).toContain('Tool definitions not sent: 9,300 (3,100 a call for 42 tools, 3 calls)');
    expect(html).toContain('Results kept out of context: 4,800 (7 tool calls in 2 runs)');
    // A reply where code mode cost more says so only in the detail.
    const behind = { ...codeMode, schemaTokensPerCall: -40, schemaTokensSaved: -120, resultTokensSaved: 0, tokensSaved: -380 };
    expect(turnStatsParts({ ...stats, codeMode: behind }).join(' ')).not.toContain('saved');
    expect(renderToStaticMarkup(<TurnStatsLine stats={{ ...stats, codeMode: behind }} />)).toContain('380 more than a tool list');
  });

  it('renders under a persisted reply and not under a live one', () => {
    const reply: ChatMessage = { id: 'a1', role: 'assistant', content: 'Finished.', createdAt: 1, turnStats: stats };
    expect(renderToStaticMarkup(<MessageBubble message={reply} chronological />)).toContain('High effort');
    expect(renderToStaticMarkup(<MessageBubble message={{ ...reply, id: 'live' }} chronological />)).not.toContain('High effort');
  });

  it('puts the stats right-aligned on the Done row, 32px clear, wrapping when narrow', () => {
    const reply: ChatMessage = { id: 'a1', role: 'assistant', content: 'Finished.', createdAt: 1, turnStats: stats };
    for (const chronological of [true, false]) {
      const html = renderToStaticMarkup(<MessageBubble message={reply} chronological={chronological} />);
      const row = html.slice(html.indexOf('data-done-row'));
      expect(html).toMatch(/flex flex-wrap items-center gap-x-8[^"]*" data-done-row/);
      expect(row.indexOf('Done.')).toBeLessThan(row.indexOf('data-turn-stats'));
      expect(row).toMatch(/class="ml-auto justify-end flex min-w-0 flex-wrap[^"]*" data-turn-stats/);
      expect(html.match(/data-turn-stats/g)).toHaveLength(1);
    }
  });

  it('keeps the stats on their own line when the reply has no Done', () => {
    const html = renderToStaticMarkup(<MessageBubble message={{ id: 'a2', role: 'assistant', content: 'Cut off', createdAt: 1, interrupted: true, turnStats: stats }} chronological />);
    expect(html).not.toContain('data-done-row');
    expect(html).toMatch(/class="mt-1 flex min-w-0 flex-wrap[^"]*" data-turn-stats/);
  });

  it('keeps stats for a reply that ended on tool calls as their own row', () => {
    const messages: ChatMessage[] = [
      { id: 'u', role: 'user', content: 'go', createdAt: 1 },
      { id: 'a', role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'grep', input: {} }], createdAt: 2, turnStats: { ...stats, modelId: 'claude-opus-5', providerId: 'claude' } },
      { id: 't', role: 'tool', content: '', toolResult: { toolCallId: 'c', output: 'x' }, createdAt: 3 },
      { id: 'u2', role: 'user', content: 'next', createdAt: 4 },
    ];
    const rows = toTranscriptRows(messages, () => [], () => []);
    expect(rows.map((r) => r.kind)).toEqual(['msg', 'activity', 'stats', 'msg']);
  });
});

describe('model chip when the saved model is gone', () => {
  const base = { providers: [{ id: 'chatgpt', kind: 'chatgpt' as const, label: 'ChatGPT (subscription)', enabled: true, baseUrl: 'http://localhost' }], providerId: 'chatgpt', models: [], modelId: null, open: false, onOpenChange: () => {}, onProvider: () => {}, onModel: () => {} };
  it('names the missing model with no floating tooltip', () => {
    const html = renderToStaticMarkup(<ModelPicker {...base} needsChoice unavailableModel="gpt-6.1-sol" />);
    expect(html).toContain('gpt-6.1-sol');
    expect(html).toContain('unavailable');
    expect(html).toContain('data-model-unavailable');
    expect(html).not.toContain('role="tooltip"');
    expect(html).not.toContain('This provider has no models loaded');
  });
  it('asks plainly for a model on a chat that never had one', () => {
    const html = renderToStaticMarkup(<ModelPicker {...base} needsChoice />);
    expect(html).toContain('Choose a model');
    expect(html).not.toContain('role="tooltip"');
  });
});
