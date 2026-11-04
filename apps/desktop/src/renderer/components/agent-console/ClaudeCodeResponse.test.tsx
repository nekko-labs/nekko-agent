import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => { Object.assign(globalThis, { window: {}, localStorage: { getItem: () => null } }); });
vi.mock('../../store.js', async (original) => {
  const actual = await original<typeof import('../../store.js')>();
  return { ...actual, useStore: Object.assign((selector: (s: ReturnType<typeof actual.useStore.getState>) => unknown) => selector(actual.useStore.getState()), actual.useStore) };
});
import type { ChatMessage, ProviderConfig, TurnStats } from '@nekko-agent/shared';
import { useStore } from '../../store.js';
import { isClaudeCodeReply } from './ClaudeCodeResponse.js';
import { MessageBubble } from './MessageBubble.js';
import { ReplyStatsRow } from './TurnStatsLine.js';

const providers = [
  { id: 'cc', kind: 'claude-code', label: 'Claude Agent', enabled: true },
  { id: 'claude-api', kind: 'anthropic', label: 'Claude', enabled: true },
  { id: 'local', kind: 'llamacpp', label: 'Built-in', enabled: true },
] as unknown as ProviderConfig[];

const stats = (providerId: string): TurnStats => ({ providerId, modelId: 'opus', inputTokens: 100, outputTokens: 20, wallMs: 3000, calls: 1 });
const reply = (providerId: string, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id: 'a1', role: 'assistant', content: 'Fixed the build.', createdAt: 1, turnStats: stats(providerId), ...extra });
const MARK = 'data-claude-code-response';

beforeEach(() => { useStore.setState({ providers, computerCatalogs: {} }); });

describe("Claude Code's response mark", () => {
  it('reads the provider kind of the turn that wrote the reply', () => {
    expect(isClaudeCodeReply(stats('cc'), providers)).toBe(true);
    expect(isClaudeCodeReply(stats('claude-api'), providers)).toBe(false);
    expect(isClaudeCodeReply(stats('local'), providers)).toBe(false);
    expect(isClaudeCodeReply(undefined, providers)).toBe(false);
    // A provider since deleted is not claimed for Claude Code.
    expect(isClaudeCodeReply(stats('gone'), providers)).toBe(false);
    // A chat running on a connected computer: that computer's providers.
    const catalogs = { pc2: { providers: [{ id: 'cc2', kind: 'claude-code' }] as unknown as ProviderConfig[], workspaces: [] } };
    expect(isClaudeCodeReply(stats('cc2'), providers, catalogs)).toBe(true);
  });

  it('ends a settled Claude Code reply, beside Done', () => {
    for (const chronological of [true, false]) {
      const html = renderToStaticMarkup(<MessageBubble message={reply('cc')} voice="reply" chronological={chronological} />);
      expect(html).toContain("Claude Code&#x27;s response");
      const row = html.slice(html.indexOf('data-done-row'));
      expect(row.indexOf('Done.')).toBeLessThan(row.indexOf(MARK));
      expect(html.match(new RegExp(MARK, 'g'))).toHaveLength(1);
    }
  });

  it('is per message: other providers, live text and user rows are unmarked', () => {
    expect(renderToStaticMarkup(<MessageBubble message={reply('claude-api')} chronological />)).not.toContain(MARK);
    expect(renderToStaticMarkup(<MessageBubble message={reply('local')} chronological />)).not.toContain(MARK);
    expect(renderToStaticMarkup(<MessageBubble message={reply('cc', { id: 'live' })} chronological />)).not.toContain(MARK);
    expect(renderToStaticMarkup(<MessageBubble message={{ id: 'u1', role: 'user', content: 'hi', createdAt: 1 }} chronological />)).not.toContain(MARK);
    // A reply with no stats (an error Nekko wrote, a recovery notice) is not Claude Code's.
    expect(renderToStaticMarkup(<MessageBubble message={{ id: 'e1', role: 'assistant', content: 'Claude Code stopped.', createdAt: 1 }} chronological />)).not.toContain(MARK);
  });

  it('leads the stats row of a reply that ended on tool calls', () => {
    expect(renderToStaticMarkup(<ReplyStatsRow stats={stats('cc')} />)).toContain(MARK);
    expect(renderToStaticMarkup(<ReplyStatsRow stats={stats('claude-api')} />)).not.toContain(MARK);
  });
});
