import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../apps/desktop/src/renderer/store';
import { WorkspacesView } from '../apps/desktop/src/renderer/views/WorkspacesView';
import { summarizeSession } from '@nekko-agent/shared';
import '../apps/desktop/src/renderer/styles.css';
import '../apps/desktop/src/renderer/components/commandWallLayouts.css';

const projects = ['Atlas', 'Beacon', 'Cedar'].map((name, i) => ({ id: `p${i + 1}`, name, folders: [`C:/fixture/${name.toLowerCase()}`] }));
const provider = { id: 'fixture', kind: 'openai', enabled: true, label: 'Offline fixture' };
const records: any[] = projects.flatMap((p, i) => [1, 2].map(n => ({ id: `${p.id}-chat${n}`, title: [`Review sidebar interactions`, `Saved project conversation`][n - 1], workspaceId: p.id, createdAt: 1000, updatedAt: 2000 - i * 10 - n, providerId: 'fixture', modelId: 'fixture-model', mode: 'agent', chatType: 'multimodal', messages: [{ id: `${p.id}-u${n}`, role: 'user', content: 'Inspect the project changes.', createdAt: 1000 }], attachments: [], queue: [] })));
let settings: any;
const calls: any[] = [];
const bridge: any = {
  getSettings: async () => settings,
  updateSettings: async (patch: any) => { calls.push({ method: 'updateSettings', patch }); settings = { ...settings, ...patch }; return settings; },
  listSessionSummaries: async () => records.map(summarizeSession),
  getSession: async (id: string) => records.find(s => s.id === id),
  setSessionOptions: async (id: string, patch: any) => { calls.push({ method: 'setSessionOptions', id, patch }); Object.assign(records.find(s => s.id === id), patch); },
  setSessionWorkspace: async (id: string, workspaceId: string) => { calls.push({ method: 'setSessionWorkspace', id, workspaceId }); records.find(s => s.id === id).workspaceId = workspaceId; },
  listTerminals: async () => [], runningSessions: async () => [], pendingInput: async () => ({}),
  listModels: async () => [], getUsageSummary: async () => null,
};
Object.assign(window, { nekko: new Proxy(bridge, { get(t, k: string) { if (k in t) return t[k]; if (k.startsWith('on')) return () => () => {}; return () => Promise.resolve(null); } }) });
localStorage.clear();
function reset() {
  records.forEach((s, i) => { s.workspaceId = projects[Math.floor(i / 2)].id; delete s.order; });
  settings = { providers: [provider], workspaces: projects, workspaceFolders: [], theme: document.documentElement.dataset.theme || 'light', experimental: {}, agent: {}, ui: {} };
  useStore.setState({ view: 'workspaces', providers: [provider], models: [], activeProviderId: 'fixture', sessions: records.map(summarizeSession), terminals: [], workspaces: [], activeSessionId: null, activeWorkspaceId: null, settings, activeSkillBySession: {}, prsBySession: Object.fromEntries(records.map(s => [s.id, []])), installedSkillDefs: [], contextPanelOpen: false, planRailOpen: false } as any);
  calls.length = 0;
}
reset();
function Fixture() {
  const [orientation, setOrientation] = useState<'vertical' | 'horizontal'>('vertical');
  const [epoch, setEpoch] = useState(0);
  Object.assign(window, { evidence: {
    configure: (next: 'vertical' | 'horizontal') => { reset(); setOrientation(next); setEpoch(x => x + 1); },
    calls: () => calls, settings: () => settings, state: () => useStore.getState(),
    groups: () => Array.from(document.querySelectorAll('[title="Drag to reorder project"]')).map(e => e.parentElement),
    event: (group: number, part: string, type: string, relatedPart?: string) => {
      const groups = Array.from(document.querySelectorAll('[title="Drag to reorder project"]')).map(e => e.parentElement!);
      const el = (g: Element, p: string) => p === 'header' ? g.querySelector('[title="Drag to reorder project"]')! : p === 'card' ? g.querySelector('[draggable="true"]:not([title="Drag to reorder project"])')! : g;
      const target = el(groups[group], part);
      const relatedTarget = relatedPart ? el(groups[group], relatedPart) : null;
      target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: new DataTransfer(), relatedTarget }));
      return true;
    },
  } });
  return <main data-evidence-route="group-drag" className="bg-paper" style={{ width: '100vw', height: '100vh', padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
    <header><h1 style={{ fontSize: 18, fontWeight: 600 }}>Project groups</h1><p className="text-ink-faint" style={{ fontSize: 12 }}>Saved chats · isolated offline evidence · {orientation}</p></header>
    <section style={{ display: 'flex', flex: 1, minHeight: 0, alignItems: 'flex-start', position: 'relative' }} key={epoch}>
      <WorkspacesView sidebarOnly orientation={orientation} onOpenChat={() => {}} onOpenTerminal={() => {}} onCreate={() => {}} onOrientation={setOrientation} onClosePanel={() => {}} />
    </section>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
