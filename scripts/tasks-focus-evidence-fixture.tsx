import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../apps/desktop/src/renderer/store';
import { putCachedSession } from '../apps/desktop/src/renderer/sessionCache';
import { CommandCenterView } from '../apps/desktop/src/renderer/views/CommandCenterView';
import { DEFAULT_WALL_STATE } from '../apps/desktop/src/renderer/commandWall';
import { PlanRail } from '../apps/desktop/src/renderer/components/PlanRail';
import { summarizeSession } from '@nekko-agent/shared';
import '../apps/desktop/src/renderer/styles.css';

const provider = { id: 'fixture', kind: 'openai', enabled: true, label: 'Fixture provider' };
const models = [{ id: 'fixture-model', providerId: 'fixture', name: 'Fixture model', contextWindow: 128000 }];
const empty: any = { id: 'fresh', title: 'New chat', createdAt: 1, updatedAt: 1, providerId: 'fixture', modelId: 'fixture-model', mode: 'agent', chatType: 'multimodal', messages: [], attachments: [], queue: [] };
const busy: any = { ...empty, id: 'busy', title: 'Ship the release', messages: [{ id: 'u', role: 'user', content: 'Ship the release notes.', createdAt: 1 }, { id: 'a', role: 'assistant', content: 'Drafted the release notes in `docs/RELEASE.md`.', createdAt: 2 }], agentPlan: [{ id: 'a', title: 'Draft notes', status: 'done' }, { id: 'b', title: 'Open PR', status: 'active' }] };
const records = [empty, busy];
const tasks: Record<string, any[]> = {
  linear: [{ id: '1', title: 'ENG-142 Sync fails on large repos', subtitle: 'Linear issue', url: 'https://linear.app/x/ENG-142' }, { id: '2', title: 'ENG-150 Add Trello connector', subtitle: 'Linear issue' }],
  tasksfile: [{ id: 't:2', title: 'Write the focus-mode spec', subtitle: 'Now' }, { id: 't:3', title: 'Capture evidence', subtitle: 'Now' }, { id: 't:7', title: 'Plan v2 connectors', subtitle: 'Later' }],
};
const bridge: any = { listSessionSummaries: async () => records.map(summarizeSession), getSession: async (id: string) => records.find((s) => s.id === id), listModels: async () => models, listTerminals: async () => [], pendingInput: async () => ({}), runningSessions: async () => [], listTasks: async () => [], listShells: async () => [], listChanges: async () => [], listFiles: async () => [], listTools: async () => [], getMcpStatus: async () => [], listSkills: async () => [], previewContext: async () => ({ items: [], totalTokens: 0, budget: 128000 }), getGitStatus: async () => ({ repo: false }), getUsageSummary: async () => null, fetchConnector: async (k: string) => tasks[k] ?? [], updateSettings: async (p: any) => ({ ...useStore.getState().settings, ...p }) };
Object.assign(window, { nekko: new Proxy(bridge, { get(t, k: string) { if (k in t) return t[k]; if (k.startsWith('on')) return () => () => {}; return () => Promise.resolve(null); } }) });
localStorage.clear();
const settings: any = { providers: [provider], workspaceFolders: [], workspaces: [], theme: 'light', experimental: {}, agent: {}, ui: {}, connectors: [{ kind: 'linear', connected: true }, { kind: 'tasksfile', connected: true, settings: { path: '/x/TASKS.md' } }],
  commandWall: { ...DEFAULT_WALL_STATE, layout: { ...DEFAULT_WALL_STATE.layout, mode: 'focus' }, root: { id: 'pane', kind: 'chat', refId: 'fresh' }, hero: 'fresh', autoAdd: false, watermark: Date.now(), dock: { ...DEFAULT_WALL_STATE.dock, show: false }, agentPanel: { show: false, orientation: 'vertical' } } };
useStore.setState({ view: 'command', providers: [provider], models, activeProviderId: 'fixture', sessions: records.map(summarizeSession), terminals: [], workspaces: [], activeSessionId: null, activeWorkspaceId: null, settings, activeSkillBySession: {}, prsBySession: {}, installedSkillDefs: [], contextPanelOpen: false, planRailOpen: false } as any);
records.forEach(putCachedSession);
function Fixture() {
  const [route, setRoute] = useState('wall');
  Object.assign(window, { evidence: { route: setRoute, state: () => useStore.getState() } });
  return <main data-evidence-route={route} style={{ height: '100vh', width: '100vw', display: 'flex', flexDirection: 'column' }} className="bg-paper">
    {route === 'wall' ? <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}><CommandCenterView /></div>
      : <div style={{ display: 'flex', height: '100%', padding: 24 }}><section data-gallery-rail style={{ width: 300, height: 640 }} className="rounded-xl border border-line bg-surface"><PlanRail sessionId="busy" session={busy} streaming={false} /></section></div>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
