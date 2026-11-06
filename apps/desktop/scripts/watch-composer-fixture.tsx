// Synthetic bridge only. No host, provider requests, credentials or external I/O.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChatPane } from '../src/renderer/components/ChatPane';
import { useStore } from '../src/renderer/store';
import { refreshAgentWatches } from '../src/renderer/agentWatches';
import { putCachedSession } from '../src/renderer/sessionCache';
import '../src/renderer/styles.css';
const now = Date.now();
const events = new Set<(event: any) => void>();
let watches: any[] = [{ id: 'fixture-watch', kind: 'pr', url: 'https://github.com/nekko-labs/nekko-agent/pull/1118', status: 'active', deadlineAt: now + 600000, nextPollAt: now + 60000, failures: 0, pending: false }];
const session: any = { id: 'fixture', title: 'Watcher lifecycle', mode: 'agent', providerId: 'local', modelId: 'fixture-model', createdAt: now, updatedAt: now, messages: [{ id: 'u', role: 'user', content: 'Verify the change and watch the PR.', createdAt: now }, { id: 'a', role: 'assistant', turnStats: { stop: 'complete', inputTokens: 100, outputTokens: 20, wallMs: 1000, calls: 1, providerId: 'local', modelId: 'fixture-model' }, content: 'Focused tests passed. Watching CI for the remaining checks.', createdAt: now, toolCalls: [{ id: 't', name: 'bash', input: { command: 'npm test' } }], toolResults: [{ toolCallId: 't', output: 'Tests passed.' }] }] };
const provider: any = { id: 'local', kind: 'openai-compatible', name: 'Fixture local provider', enabled: true, baseUrl: 'http://127.0.0.1:1' };
const bridge: any = {
  getSession: async () => session, listAgentWatches: async () => watches,
  nextAgentWatchAt: async () => watches.find(w => w.status === 'active')?.deadlineAt ?? null,
  cancelAgentWatch: async (_session: string, id: string) => { watches = watches.map(w => w.id === id ? { ...w, status: 'cancelled' } : w); },
  onAgentEvent: (cb: any) => { events.add(cb); return () => events.delete(cb); },
  listTools: async () => [], getMcpStatus: async () => [], listSkills: async () => [], listTasks: async () => [], listChanges: async () => [],
  runningSessions: async () => [], pendingInput: async () => ({}), listSessionSummaries: async () => [],
  listFiles: async () => [], listModels: async () => [{ id: 'fixture-model', name: 'Fixture model', providerId: 'local' }], getGitStatus: async () => ({ repo: false }),
  suggestReplies: async () => ({ options: [], next: 'Check the latest PR status.' }),
  previewContext: async () => ({ items: [], totalTokens: 0, budget: 128000 }),
};
(window as any).nekko = new Proxy(bridge, { get(t, k: string) { if (k in t) return t[k]; if (k.startsWith('on')) return () => () => {}; return async () => null; } });
(window as any).nekkoChrome = { platform: 'darwin' };
useStore.setState({ providers: [provider], models: [{ id: 'fixture-model', name: 'Fixture model', providerId: 'local' }], sessions: [], settings: { providers: [provider], experimental: {}, agent: {}, ui: { onboarded: true } } } as any);
putCachedSession(session);
(window as any).watchFixture = { events, compact: () => useStore.setState({ planRailOpen: false, planRailOpenBySession: { fixture: false } }), suggest: () => events.forEach(cb => cb({ sessionId: 'fixture', type: 'done' })), due: () => { watches = watches.map(w => ({ ...w, pending: true })); refreshAgentWatches('fixture'); } };
const root = createRoot(document.getElementById('root')!);
(window as any).watchFixture.unmount = () => root.unmount();
root.render(<div style={{ width: '100vw', height: '100vh', display: 'flex', minWidth: 0 }}><ChatPane sessionId="fixture" /></div>);
