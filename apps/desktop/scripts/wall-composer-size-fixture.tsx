import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../src/renderer/store';
import { putCachedSession } from '../src/renderer/sessionCache';
import { CommandCenterView } from '../src/renderer/views/CommandCenterView';
import { DEFAULT_WALL_STATE } from '../src/renderer/commandWall';
import { summarizeSession } from '@nekko-agent/shared';

// The Command Center with two synthetic agent windows side by side and the
// composer below, plus a way to leave the page and come back, which is what
// unmounts the wall in the app. Synthetic records only; no host or network.
const provider = { id: 'fixture', kind: 'openai', enabled: true, label: 'Fixture provider', auth: 'subscription', tokenKey: 'fixture' };
const models = [{ id: 'fixture-model', providerId: 'fixture', name: 'Fixture model', contextWindow: 128000 }];
const session = (id: string, title: string) => ({ id, title, createdAt: Date.now(), updatedAt: Date.now(), providerId: 'fixture', modelId: 'fixture-model', mode: 'agent', chatType: 'multimodal', messages: [{ id: `${id}-m`, role: 'assistant', content: `Synthetic reply in ${title}.`, createdAt: Date.now() }], attachments: [], queuedPrompts: [] });
const records = [session('left', 'Nekko Assistant Features'), session('right', 'Diagnose model never activating')];
const bridge: any = {
  listSessionSummaries: async () => records.map(summarizeSession), listTerminals: async () => [],
  getSession: async (id: string) => records.find((s) => s.id === id), listModels: async () => models,
  getUsageSummary: async () => null, pendingInput: async () => ({}), runningSessions: async () => [],
  listTasks: async () => [], listShells: async () => [], listChanges: async () => [], listFiles: async () => [],
  previewContext: async () => ({ items: [], totalTokens: 0, budget: 128000 }), getGitStatus: async () => ({ repo: false }),
  listTools: async () => [], getMcpStatus: async () => [], listSkills: async () => [],
  updateSettings: async (patch: any) => ({ ...useStore.getState().settings, ...patch }),
};
Object.assign(window, { nekko: new Proxy(bridge, { get(target, key: string) { if (key in target) return target[key]; if (key.startsWith('on')) return () => () => {}; return () => Promise.resolve(null); } }) });

localStorage.clear();
const root = { id: 'split-1', dir: 'row', children: [{ id: 'pane-left', kind: 'chat', refId: 'left' }, { id: 'pane-right', kind: 'chat', refId: 'right' }], sizes: [0.5, 0.5] };
useStore.setState({ view: 'command', providers: [provider], models, activeProviderId: 'fixture', sessions: records.map(summarizeSession), terminals: [], workspaces: [], activeWorkspaceId: null, activeSessionId: null, settings: { providers: [provider], workspaceFolders: [], workspaces: [], theme: 'dark', experimental: {}, agent: {}, ui: {}, commandWall: { ...DEFAULT_WALL_STATE, root, hero: 'right', autoAdd: false, watermark: Date.now(), dock: { ...DEFAULT_WALL_STATE.dock, show: false }, agentPanel: { show: false, orientation: 'vertical' } } }, activeSkillBySession: {}, prsBySession: {}, installedSkillDefs: [], contextPanelOpen: false, planRailOpen: false } as any);
records.forEach(putCachedSession);

function Fixture() {
  const [page, setPage] = useState<'command' | 'other'>('command');
  Object.assign(window, { integration: { page: setPage } });
  // The app shell gives the view the window's full width and remaining height.
  return <main style={{ height: '100vh', width: '100vw', display: 'flex', flexDirection: 'column' }}>{page === 'command' ? <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}><CommandCenterView /></div> : <div data-other-page style={{ padding: 24 }}>Another page (Skills)</div>}</main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
