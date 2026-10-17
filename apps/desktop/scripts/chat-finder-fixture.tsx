import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../src/renderer/store';
import { WorkspacesView } from '../src/renderer/views/WorkspacesView';
import { summarizeSession } from '@nekko-agent/shared';
import '../src/renderer/styles.css';

// Synthetic records only. This fixture never connects to a host or daemon.
const DAY = 86_400_000;
const now = Date.now();
const titles: Array<[string, number, string?]> = [
  ['Pull latest main', 0.01], ['Fix chat scroll bounce', 1, 'the transcript bounces when reduced motion is on'], ['Refactor sidebar groups', 4],
  ['Add Android skills bridge', 12], ['Wall dock monitors rename', 29], ['Login page redesign', 45, 'fix the oauth redirect'],
  ['Budget pricing table', 70], ['Release notes for v0.7', 130], ['Benchmark tokens per second', 400],
];
const sessions = titles.map(([title, age, prompt], i) => summarizeSession({
  id: `s${i}`, title, createdAt: now - age * DAY, updatedAt: now - age * DAY, providerId: 'fixture', modelId: 'fixture-model', mode: 'agent', chatType: 'multimodal',
  messages: prompt ? [{ id: `m${i}`, role: 'user', content: prompt, createdAt: now - age * DAY }] : [], ...(i === 5 ? { archivedAt: now - 40 * DAY } : {}),
} as any));
const opened: string[] = [];
Object.assign(window, { nekko: new Proxy({ listSessionSummaries: async () => sessions, listTerminals: async () => [], runningSessions: async () => [], pendingInput: async () => ({}) } as any, { get(t, k: string) { if (k in t) return t[k]; if (k.startsWith('on')) return () => () => {}; return () => Promise.resolve(null); } }) });
function Fixture() {
  const [selected, setSelected] = useState<string | undefined>();
  React.useLayoutEffect(() => { useStore.setState({ sessions, terminals: [], workspaces: [], settings: { providers: [], workspaces: [], experimental: {}, agent: {}, ui: {} } } as any); }, []);
  Object.assign(window, { integration: { opened } });
  return <main style={{ height: '100vh', width: 300 }}><WorkspacesView sidebarOnly selectedId={selected} onOpenChat={(id) => { opened.push(id); setSelected(id); }} /></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
