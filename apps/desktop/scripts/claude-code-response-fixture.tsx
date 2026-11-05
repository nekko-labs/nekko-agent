// Synthetic bridge only. No host, provider requests, credentials or external I/O.
// A Claude Agent chat: Claude Code's replies have a speaker header;
// a turn routed to a local model in the same chat does not.
// Run: NEKKO_FIXTURE=claude-code-response-fixture.tsx NEKKO_SANDBOX=claude-code-response-sandbox.cjs node chat-search-integration.cjs
import React from 'react';
import { createRoot } from 'react-dom/client';
import type { ChatMessage, ProviderConfig, TurnStats } from '@nekko-agent/shared';
(window as any).nekko = new Proxy({}, {
  get(_t: any, k: string) { if (k.startsWith('on')) return () => () => {}; return async () => null; },
});
import { useStore } from '../src/renderer/store';
import { MessageBubble } from '../src/renderer/components/agent-console/MessageBubble';
import '../src/renderer/styles.css';

useStore.setState({
  providers: [
    { id: 'cc', kind: 'claude-code', label: 'Claude Agent', enabled: true },
    { id: 'local', kind: 'llamacpp', label: 'Built-in', enabled: true },
  ] as unknown as ProviderConfig[],
});

const stats = (providerId: string, modelId: string, extra: Partial<TurnStats> = {}): TurnStats =>
  ({ providerId, modelId, inputTokens: 1800, cacheReadTokens: 21_000, outputTokens: 420, outputMs: 6000, wallMs: 14_200, calls: 3, steps: 2, stop: 'complete', ...extra });

const messages: ChatMessage[] = [
  { id: 'u1', role: 'user', content: 'Why does the build fail on Windows?', createdAt: 1 },
  { id: 'a1', role: 'assistant', content: 'The path join in `scripts/pack.mjs` used a forward slash before the drive letter. I switched it to `path.join` and the build passes now.', createdAt: 2, turnStats: stats('cc', 'opus', { effort: 'high' }) },
  { id: 'u2', role: 'user', content: 'What does EPERM mean, briefly?', createdAt: 3 },
  { id: 'a2', role: 'assistant', content: 'EPERM is "operation not permitted": the OS refused the call, usually a locked or read-only file.', createdAt: 4, turnStats: stats('local', 'qwen3-8b', { inputTokens: 900, cacheReadTokens: 0, outputTokens: 40, wallMs: 1100, calls: 1, steps: 0 }) },
];

createRoot(document.getElementById('root')!).render(
  <div className="flex min-h-screen flex-col gap-5 bg-surface p-6 text-ink" style={{ width: '100%', maxWidth: 680 }} data-transcript>
    {messages.map((m) => <MessageBubble key={m.id} message={m} voice={m.role === 'assistant' ? 'reply' : undefined} chronological />)}
  </div>,
);
