// Synthetic bridge only. No host, provider requests, credentials or external I/O.
// Reply measurements with the prompt-cache share: a local llama.cpp reply whose
// prefix held (2,439 tokens reused, 15 prefilled) and a reply whose provider
// reported no cache counters, which claims nothing.
// Run: NEKKO_FIXTURE=reply-cache-stats-fixture.tsx NEKKO_SANDBOX=reply-cache-stats-sandbox.cjs node chat-search-integration.cjs
import React from 'react';
import { createRoot } from 'react-dom/client';
import type { ChatMessage, ProviderConfig, TurnStats } from '@nekko-agent/shared';
(window as any).nekko = new Proxy({}, {
  get(_t: any, k: string) { if (k.startsWith('on')) return () => () => {}; return async () => null; },
});
// Measurements show in Expert mode.
window.localStorage.setItem('nekko.chatMode', 'expert');
import { useStore } from '../src/renderer/store';
import { MessageBubble } from '../src/renderer/components/agent-console/MessageBubble';
import '../src/renderer/styles.css';

useStore.setState({
  providers: [
    { id: 'local', kind: 'llamacpp', label: 'Built-in', enabled: true },
    { id: 'lms', kind: 'lmstudio', label: 'LM Studio', enabled: true },
  ] as unknown as ProviderConfig[],
});

const stats = (providerId: string, modelId: string, extra: Partial<TurnStats>): TurnStats =>
  ({ providerId, modelId, inputTokens: 15, outputTokens: 120, outputMs: 900, wallMs: 1300, calls: 1, steps: 0, stop: 'complete', ...extra });

const messages: ChatMessage[] = [
  { id: 'u1', role: 'user', content: 'Summarise the build log.', createdAt: 1 },
  { id: 'a1', role: 'assistant', content: 'Two warnings, no errors: an unused import in pack.mjs and a deprecated flag in the test runner.', createdAt: 2, turnStats: stats('local', 'qwen3-4b', { cacheReadTokens: 2_439 }) },
  { id: 'u2', role: 'user', content: 'And the earlier run?', createdAt: 3 },
  { id: 'a2', role: 'assistant', content: 'The earlier run failed on the same deprecated flag.', createdAt: 4, turnStats: stats('lms', 'qwen3-8b', { inputTokens: 2_460 }) },
];

createRoot(document.getElementById('root')!).render(
  <div className="flex min-h-screen flex-col gap-5 bg-surface p-6 text-ink" style={{ width: '100%', maxWidth: 680 }} data-transcript>
    {messages.map((m) => <MessageBubble key={m.id} message={m} voice={m.role === 'assistant' ? 'reply' : undefined} chronological />)}
  </div>,
);
