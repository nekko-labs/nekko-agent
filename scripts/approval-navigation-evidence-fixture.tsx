import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatPane } from '../apps/desktop/src/renderer/components/ChatPane';
import { ActivityGroup } from '../apps/desktop/src/renderer/components/agent-console/ActivityGroup';
import { ToolCard } from '../apps/desktop/src/renderer/components/agent-console/ToolCard';
import { SubagentParentContext } from '../apps/desktop/src/renderer/components/agent-console/SubagentCue';
import { useStore } from '../apps/desktop/src/renderer/store';
import { putCachedSession } from '../apps/desktop/src/renderer/sessionCache';
import { foldSubagentActivity } from '../apps/desktop/src/renderer/subagentActivity';
import '../apps/desktop/src/renderer/styles.css';

// Full ChatPane with synthetic bridge only. No host, daemon, credentials or network.
const call = { id: 'approval-a', name: 'bash', input: { command: 'Remove synthetic build output' } };
const spawn = { id: 'spawn-a', name: 'spawn_agent', input: { title: 'Investigate navigation', task: 'Check navigation without changing the parent layout.' } };
const parent: any = { id: 'parent', title: 'Approval and navigation fixture', createdAt: 1, updatedAt: 1, messages: [{ id: 'u', role: 'user', content: 'Check the synthetic build output.', createdAt: 1 }], providerId: 'fixture', modelId: 'fixture-model', mode: 'guardrails', attachments: [], queue: [] };
const child: any = { ...parent, id: 'child', parentSessionId: 'parent', title: 'Investigate navigation', createdAt: 20, messages: [] };
const listeners = new Set<(e: any) => void>();
let pending: any = {};
const decisions: any[] = [];
const settings: any = { providers: [], workspaces: [], workspaceFolders: [], theme: 'light', experimental: {}, developer: {}, agent: {}, ui: {} };
const bridge: any = {
  onAgentEvent: (f: any) => { listeners.add(f); return () => listeners.delete(f); },
  pendingInput: async () => pending,
  getSession: async (id: string) => id === 'parent' ? parent : child,
  listSessionSummaries: async () => [parent, child],
  runningSessions: async () => [], listTools: async () => [], listModels: async () => [], listTasks: async () => [], listSkills: async () => [], listTerminals: async () => [], getMcpStatus: async () => [],
  previewContext: async () => ({ items: [], totalTokens: 0, budget: 128000 }),
  approveTool: async (...args: any[]) => { decisions.push(args); pending = {}; },
};
Object.assign(window, { nekko: new Proxy(bridge, { get(t, k: string) { if (k in t) return t[k]; if (k.startsWith('on')) return () => () => {}; return () => Promise.resolve(null); } }) });
useStore.setState({ settings, settingsLoaded: true, sessions: [parent, child], providers: [], models: [], activeProviderId: null, workspaces: [], terminals: [], installedSkillDefs: [], activeSkillBySession: {}, prsBySession: {}, contextPanelOpen: false, planRailOpen: false } as any);
[parent, child].forEach(putCachedSession);
foldSubagentActivity({ type: 'tool_call', sessionId: 'parent', call: spawn }, 10);
function Fixture() {
  const [route, setRoute] = useState('chat');
  const [epoch, setEpoch] = useState(0);
  Object.assign(window, { evidence: {
    route: (r: string) => { setRoute(r); setEpoch(e => e + 1); },
    emit: (e: any) => { for (const f of listeners) f({ sessionId: 'parent', ...e }); },
    hydrate: () => { pending = { parent: { sessionId: 'parent', approval: { call, reason: 'Synthetic cleanup needs approval', severity: 'high', requestedAt: 1 } } }; setEpoch(e => e + 1); },
    approval: () => { const e = { type: 'tool_approval_required', call, reason: 'Synthetic cleanup needs approval', severity: 'high' }; for (const f of listeners) f({ sessionId: 'parent', ...e }); },
    state: () => useStore.getState(), decisions,
  } });
  return <main key={epoch} className="bg-paper text-ink" style={{ width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column' }}>
    {route === 'chat' ? <ChatPane sessionId="parent" /> : <SubagentParentContext.Provider value={[child]}><div style={{ padding: 24 }}><h1>Delegated work</h1><ActivityGroup items={[{ kind: 'tool', call: spawn }]} /><ToolCard call={spawn} /></div></SubagentParentContext.Provider>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
