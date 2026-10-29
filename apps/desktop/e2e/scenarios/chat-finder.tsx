import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../../src/renderer/store';
import { AgentSidebar } from '../../src/renderer/views/WorkspacesView';
import { summarizeSession } from '@nekko-agent/shared';
import '../../src/renderer/styles.css';

// Synthetic records only. This fixture never connects to a host or daemon.
const DAY = 86_400_000;
const now = Date.now();
const titles: Array<[string, number, string?, string?, string?, string?]> = [
  // title, age days, first prompt, later reply, workspace, provider
  ['Pull latest main', 0.01, undefined, undefined, 'w1', 'ant'], ['Fix chat scroll bounce', 1, 'the transcript bounces when reduced motion is on', 'Clamped the overscroll in VirtualTranscript', 'w1', 'ant'],
  ['Refactor sidebar groups', 4, undefined, 'Wrote [Sidebar plan](C:/fixture/reports/sidebar-plan.md)', 'w1', 'eng'],
  ['Add Android skills bridge', 12, undefined, undefined, 'w2', 'eng'], ['Wall dock monitors rename', 29, undefined, undefined, undefined, 'ant'],
  ['Login page redesign', 45, 'fix the oauth redirect', undefined, 'w2', 'ant'],
  ['Budget pricing table', 70, undefined, 'The Stripe tiers are wired up', undefined, 'eng'], ['Release notes for v0.7', 130, undefined, undefined, 'w1', 'ant'], ['Benchmark tokens per second', 400, undefined, undefined, undefined, 'eng'],
];
const full = titles.map(([title, age, prompt, reply, workspaceId, providerId], i) => ({
  id: `s${i}`, title, createdAt: now - age * DAY, updatedAt: now - age * DAY, providerId, modelId: 'fixture-model', mode: 'agent', chatType: 'multimodal', workspaceId,
  messages: [
    ...(prompt ? [{ id: `m${i}`, role: 'user', content: prompt, createdAt: now - age * DAY }] : []),
    { id: `u${i}`, role: 'user', content: i === 1 ? 'also check the kerning on the header' : `follow up ${i}`, createdAt: now - age * DAY },
    ...(reply ? [{ id: `r${i}`, role: 'assistant', content: reply, createdAt: now - age * DAY }] : []),
  ],
  ...(i === 5 ? { archivedAt: now - 40 * DAY } : {}),
} as any));
const sessions = full.map((s) => summarizeSession(s));
const opened: string[] = [];
Object.assign(window, { nekko: new Proxy({ listSessionSummaries: async () => sessions, getSession: async (id: string) => full.find((s) => s.id === id) ?? null, listTerminals: async () => [], runningSessions: async () => [], pendingInput: async () => ({}) } as any, { get(t, k: string) { if (k in t) return t[k]; if (k.startsWith('on')) return () => () => {}; return () => Promise.resolve(null); } }) });
const providers = [
  { id: 'eng', label: 'Nekko Agent engine', kind: 'llamacpp', baseUrl: 'http://127.0.0.1:8080', enabled: true },
  { id: 'ant', label: 'Claude API', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', enabled: true },
];
const workspaces = [{ id: 'w1', name: 'nekko-agent', path: 'C:/fixture' }, { id: 'w2', name: 'website', path: 'C:/site' }];
function Fixture() {
  const [selected, setSelected] = useState<string | undefined>();
  React.useLayoutEffect(() => { useStore.setState({ sessions, providers, terminals: [], workspaces: [], settings: { providers, workspaces, experimental: {}, agent: {}, ui: {} } } as any); }, []);
  Object.assign(window, { integration: { opened, findSeed: () => useStore.getState().findSeed } });
  return <main style={{ height: '100vh', width: 300 }}><AgentSidebar selectedId={selected ?? null} onOpenChat={(id) => { opened.push(id); setSelected(id); }} onOpenTerminal={() => {}} onCreate={async () => {}} /></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
