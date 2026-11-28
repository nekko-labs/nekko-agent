import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.hoisted(() => { Object.assign(globalThis, { window: {}, localStorage: { getItem: () => null } }); });
import type { ChatMessage, ProviderConfig, TurnStats } from '@nekko-agent/shared';
import { useStore } from '../../store.js';
import { MessageBubble } from './MessageBubble.js';

const providers = [
  { id: 'claude-code-test', kind: 'claude-code', label: 'Claude Agent', enabled: true },
  { id: 'local', kind: 'llamacpp', label: 'Built-in', enabled: true },
] as unknown as ProviderConfig[];

function reply(providerId: string, modelId: string): ChatMessage {
  const turnStats: TurnStats = { providerId, modelId, inputTokens: 100, outputTokens: 20, wallMs: 3000, calls: 1 };
  return { id: providerId, role: 'assistant', content: 'Fixed the build.', createdAt: 1, turnStats };
}

describe('assistant reply provenance', () => {
  it.each([true, false])('starts with reply content and preserves per-turn model/provider details (chronological=%s)', (chronological) => {
    useStore.setState({ providers, computerCatalogs: {} });
    for (const [providerId, modelId] of [['claude-code-test', 'opus'], ['local', 'qwen3-8b']]) {
      const html = renderToStaticMarkup(<MessageBubble message={reply(providerId, modelId)} voice="reply" chronological={chronological} />);
      expect(html).not.toContain('data-claude-code-response');
      expect(html).toMatch(/class="msg-ai"[^>]*><div data-chat-search-text/);
      expect(html).toContain('Fixed the build.');
      expect(html).toContain('data-turn-stats');
      expect(html).toContain(`Model: ${modelId} (${providerId})`);
    }
  });
});
