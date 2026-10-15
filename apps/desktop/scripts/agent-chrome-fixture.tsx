import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../src/renderer/store';
import { putCachedSession } from '../src/renderer/sessionCache';
import { applyEvent } from '../src/renderer/liveRuns';
import { CommandCenterView } from '../src/renderer/views/CommandCenterView';
import { DEFAULT_WALL_STATE } from '../src/renderer/commandWall';
import { summarizeSession } from '@agent-nekko/shared';
import '../src/renderer/styles.css';

// Synthetic records only: an Opus 5.5 agent with two folders and a file, and two
// running sub-agents. Never connects to a host, daemon or network.
const provider = { id: 'fixture', kind: 'anthropic', enabled: true, label: 'Fixture Claude', auth: 'apiKey', tokenKey: 'fixture' };
const models = [{ id: 'claude-opus-5-5', providerId: 'fixture', name: 'Claude Opus 5.5', contextWindow: 1000000 }];
const workspaces = [
  { id: 'ws-a', name: 'agent-nekko', path: 'C:\\code\\agent-nekko', addedAt: 1 },
  { id: 'ws-b', name: 'docs', path: 'C:\\code\\docs', addedAt: 2 },
];
const now = Date.now();
const base = { createdAt: now, updatedAt: now, providerId: 'fixture', modelId: 'claude-opus-5-5', mode: 'agent', chatType: 'multimodal', queue: [] };
const reply = (id: string, content: string) => ({ id, role: 'assistant', content, createdAt: now });
const records: any[] = [
  { ...base, id: 'parent', title: 'Refactor wall chrome', workspaceId: 'ws-a', supportingWorkspaceIds: ['ws-b'], attachedPaths: ['C:\\code\\notes\\plan.md'],
    messages: [{ id: 'u1', role: 'user', content: 'Tidy the agent window header.', createdAt: now }, reply('a1', 'Delegating the checks to two sub-agents.')] },
  { ...base, id: 'child-1', title: 'Run unit tests', parentSessionId: 'parent', messages: [] },
  { ...base, id: 'child-2', title: 'Capture screenshots', parentSessionId: 'parent', messages: [] },
];
const bridge: any = {
  listSessionSummaries: async () => records.map(summarizeSession), listTerminals: async () => [],
  getSession: async (id: string) => records.find((s) => s.id === id), listModels: async () => models,
  getUsageSummary: async () => null, pendingInput: async () => ({}), runningSessions: async () => ['parent', 'child-1', 'child-2'],
  listTasks: async () => [], listShells: async () => [], listChanges: async () => [], listFiles: async () => [],
  previewContext: async () => ({ items: [], totalTokens: 0, budget: 1000000 }), getGitStatus: async () => ({ repo: false }),
  getLimits: async () => null, listTools: async () => [], getMcpStatus: async () => [], listSkills: async () => [],
  readTerminal: async () => '', terminalRead: async () => '',
  setSessionWorkspace: async (id: string, wid?: string) => { const s = records.find((r) => r.id === id); s.workspaceId = wid; return { ...s }; },
  setSessionSupportingWorkspaces: async (id: string, ids: string[]) => { const s = records.find((r) => r.id === id); s.supportingWorkspaceIds = ids; return { ...s }; },
  setSessionAttachments: async (id: string, paths: string[]) => { const s = records.find((r) => r.id === id); s.attachedPaths = paths; return { ...s }; },
};
Object.assign(window, { nekko: new Proxy(bridge, { get(target, key: string) { if (key in target) return target[key]; if (key.startsWith('on')) return () => () => {}; return () => Promise.resolve(null); } }) });

function Fixture() {
  const [epoch, setEpoch] = useState(0);
  const reset = () => {
    localStorage.clear();
    for (const id of ['child-1', 'child-2']) applyEvent({ type: 'text', sessionId: id, delta: 'Working on it' } as any);
    useStore.setState({ providers: [provider], models, activeProviderId: 'fixture', sessions: records.map(summarizeSession), terminals: [], workspaces: [], activeWorkspaceId: null, activeSessionId: null, activeProjectId: 'ws-a',
      settings: { providers: [provider], workspaces, theme: 'light', effort: 'normal', experimental: {}, agent: {}, ui: {}, commandWall: { ...DEFAULT_WALL_STATE, root: { id: 'pane-parent', kind: 'chat', refId: 'parent' }, autoAdd: false, watermark: now, dock: { ...DEFAULT_WALL_STATE.dock, show: false } } },
      activeSkillBySession: {}, prsBySession: {}, installedSkillDefs: [], contextPanelOpen: false, planRailOpen: false } as any);
    records.forEach(putCachedSession); setEpoch((e) => e + 1);
  };
  const finishParent = () => applyEvent({ type: 'done', sessionId: 'parent' } as any);
  Object.assign(window, { integration: { reset, finishParent, records: () => records } });
  React.useEffect(reset, []);
  return <main style={{ height: '100vh' }} key={epoch}><CommandCenterView /></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
