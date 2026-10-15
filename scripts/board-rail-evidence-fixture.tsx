import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../apps/desktop/src/renderer/store';
import { CommandCenterView } from '../apps/desktop/src/renderer/views/CommandCenterView';
import { DEFAULT_WALL_STATE, WALL_STATE_KEY } from '../apps/desktop/src/renderer/commandWall';
import { summarizeSession } from '@nekko-agent/shared';
import { EvidenceNav, EvidenceMobileNav } from './board-rail-evidence-nav';
import '../apps/desktop/src/renderer/styles.css';
import '../apps/desktop/src/renderer/components/commandWallLayouts.css';

const projects = [{ id: 'atlas', name: 'Atlas', folders: ['C:/fixture/atlas'] }];
const provider = { id: 'offline', kind: 'openai', enabled: true, label: 'Offline fixture' };
const records: any[] = ['Review rail spacing', 'Check board layout'].map((title, i) => ({ id: `chat${i}`, title, workspaceId: 'atlas', createdAt: 1000, updatedAt: 2000, providerId: 'offline', modelId: 'offline', mode: 'agent', chatType: 'multimodal', messages: [{ id: `m${i}`, role: 'user', content: 'Offline pane fixture.', createdAt: 1000 }], attachments: [], queue: [] }));
const calls: any[] = [];
let settings: any;
const bridge: any = {
  getSettings: async () => settings,
  updateSettings: async (patch: any) => { calls.push({ method: 'updateSettings', patch }); settings = { ...settings, ...patch }; return settings; },
  listSessionSummaries: async () => records.map(summarizeSession), getSession: async (id: string) => records.find(s => s.id === id),
  listTerminals: async () => [], runningSessions: async () => [], pendingInput: async () => ({}), listTasks: async () => [],
  listModels: async () => [], getUsageSummary: async () => null,
};
Object.assign(window, { nekko: new Proxy(bridge, { get(t, k: string) { if (k in t) return t[k]; if (k.startsWith('on')) return () => () => {}; return (...args: any[]) => { calls.push({ method: k, args }); return Promise.resolve(null); }; } }) });
localStorage.clear();
const wall = { ...DEFAULT_WALL_STATE, layout: { mode: 'grid', cols: 2, rows: 1 }, root: { id: 'split', dir: 'row', sizes: [.5, .5], children: [{ id: 'pane0', kind: 'chat', refId: 'chat0' }, { id: 'pane1', kind: 'chat', refId: 'chat1' }] }, watermark: 2000, autoAdd: false, agentPanel: { show: true, orientation: 'vertical' } };
localStorage.setItem(WALL_STATE_KEY, JSON.stringify(wall));
settings = { providers: [provider], workspaces: projects, workspaceFolders: [], experimental: { training: true, memory: true }, agent: {}, ui: {}, commandWall: wall };
useStore.setState({ view: 'command', providers: [provider], models: [], sessions: records.map(summarizeSession), terminals: [], workspaces: [], activeSessionId: null, activeWorkspaceId: null, activeProjectId: null, settings, settingsLoaded: true, activeSkillBySession: {}, prsBySession: {}, installedSkillDefs: [], contextPanelOpen: false, planRailOpen: false } as any);
function Fixture() {
  const [epoch, setEpoch] = useState(0);
  Object.assign(window, { evidence: { calls, state: () => useStore.getState(), reset: () => { localStorage.setItem(WALL_STATE_KEY, JSON.stringify(wall)); setEpoch(x => x + 1); } } });
  return <div className="flex h-full w-full flex-col" style={{ background: 'var(--paper)' }}><div className="relative flex min-h-0 w-full flex-1"><EvidenceNav /><main className="relative flex min-w-0 flex-1 flex-col pb-16 md:pb-0"><CommandCenterView key={epoch} /></main></div><EvidenceMobileNav /></div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
