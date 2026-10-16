import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../src/renderer/store';
import { putCachedSession } from '../src/renderer/sessionCache';
import { CommandCenterView } from '../src/renderer/views/CommandCenterView';
import { WorkspacesView } from '../src/renderer/views/WorkspacesView';
import { Mascot } from '../src/renderer/components/Mascot';
import { UpdateProvider } from '../src/renderer/components/UpdateBanner';
import { SettingsView } from '../src/renderer/views/SettingsView';
import { DEFAULT_WALL_STATE } from '../src/renderer/commandWall';
import { summarizeSession } from '@nekko-agent/shared';
import '../src/renderer/styles.css';

// Synthetic records only. This fixture never connects to a host or daemon.
const provider = { id: 'fixture', kind: 'openai', enabled: true, label: 'Fixture provider', auth: 'subscription', tokenKey: 'fixture' };
const models = [{ id: 'fixture-model', providerId: 'fixture', name: 'Fixture model', contextWindow: 128000 }, ...Array.from({ length: 40 }, (_, i) => ({ id: `catalog-${i}`, providerId: 'fixture', name: `Catalog model ${i}`, contextWindow: 128000 }))];
const makeSession = (id: string) => ({ id, title: id === 'existing' ? 'Existing conversation' : `Synthetic ${id}`, createdAt: Date.now(), updatedAt: Date.now(), providerId: 'fixture', modelId: 'fixture-model', mode: 'agent', chatType: 'multimodal', messages: [], attachments: [], queuedPrompts: [] });
let records: any[] = [];
let terminals: any[] = [];
let serial = 0;
const calls: any[] = [];
const failures = { create: false, options: false, cleanup: false };
const bridge: any = {
  getAppInfo: async () => ({version:'0.8.0', platform:'win32'}),
  getRemoteStatus: async () => ({enabled:false,relayUrl:'',devices:[]}),
  getRemotePairing: async () => null,
  createSession: async (workspaceId: string) => { calls.push({ method: 'create', workspaceId }); if (failures.create) throw Error('Synthetic creation failure'); const s = { ...makeSession(`new-${++serial}`), workspaceId }; records.push(s); return s; },
  setSessionOptions: async (id: string, options: any) => { calls.push({ method: 'options', id, options }); if (failures.options) throw Error('Synthetic options failure'); const s = records.find(s => s.id === id); Object.assign(s, options); return {...s}; },
  abortChat: async (id: string) => { calls.push({ method: 'abort', id }); },
  setSessionWorkspace: async (id: string, workspaceId?: string) => { calls.push({ method: 'workspace', id, workspaceId }); Object.assign(records.find(s => s.id === id), { workspaceId }); },
  deleteSession: async (id: string) => { calls.push({ method: 'cleanup', id }); if (failures.cleanup) throw Error('Synthetic cleanup failure'); records = records.filter(s => s.id !== id); },
  createTerminal: async (options: any) => { calls.push({ method: 'terminal', options }); const t = { id: `terminal-${++serial}`, title: 'Synthetic terminal', cwd: '/synthetic', shell: '/bin/sh', running: false }; terminals.push(t); return t; },
  listSessionSummaries: async () => records.map(summarizeSession), listTerminals: async () => terminals,
  getSession: async (id: string) => records.find(s => s.id === id), listModels: async () => models,
  getRemoteAccessState: async () => ({enabled:false,relayUrl:'',devices:[]}), getRemoteAccessSettings: async () => ({enabled:false,relayUrl:''}), getUsageSummary: async () => null, pendingInput: async () => ({}), runningSessions: async () => [],
  listTasks: async () => [], listShells: async () => [{id:99,label: String.fromCharCode(80,111,119,101,114,83,104,101,108,108),path: String.fromCharCode(47,98,105,110,47,115,104)}], listChanges: async () => [], listFiles: async () => [],
  previewContext: async () => ({ items: [], totalTokens: 0, budget: 128000 }), getGitStatus: async () => ({ repo: false }),
  getLimits: async (key: string, refresh?: boolean) => { calls.push({method:'limits',key,refresh}); return {updatedAt:Date.now(),staleAfterMs:60000,windows:[{id:'hour',label:'5-hour',usedPercent:17,resetAt:Date.now()+3600000},{id:'week',label:'7-day',usedPercent:40,resetAt:Date.now()+86400000}]}; }, listTools: async () => [], getMcpStatus: async () => [], listSkills: async () => [],
  terminalRead: async () => '', readTerminal: async () => '', updateSettings: async (patch: any) => { calls.push({method:'settings',patch}); return {...useStore.getState().settings,...patch}; },
};
Object.assign(window, { nekko: new Proxy(bridge, { get(target, key: string) { if (key in target) return target[key]; if (key.startsWith('on')) return () => () => {}; return () => Promise.resolve(null); } }) });
function Fixture() {
  const [epoch, setEpoch] = useState(0);
  const [route, setRoute] = useState('command');
  const reset = () => {
    records = [makeSession('existing')]; terminals = []; serial = 0; calls.length = 0;
    Object.assign(failures, { create: false, options: false, cleanup: false });
    localStorage.clear();
    useStore.setState({ view: 'command', providers: [provider], models, activeProviderId: 'fixture', sessions: records.map(summarizeSession), terminals: [], workspaces: [], activeWorkspaceId: null, activeSessionId: null, activeProjectId: 'synthetic-project', settings: { providers: [provider], guardrails: [], workspaceFolders: [], workspaces: [], theme: 'light', experimental: {}, agent: {}, ui: {}, commandWall: { ...DEFAULT_WALL_STATE, root: { id: 'synthetic-pane', kind: 'chat', refId: 'existing' }, autoAdd: false, watermark: Date.now(), dock: { ...DEFAULT_WALL_STATE.dock, show: false } } }, activeSkillBySession: {}, prsBySession: {}, installedSkillDefs: [], contextPanelOpen: false, planRailOpen: false } as any);
    records.forEach(putCachedSession); setRoute('command'); setEpoch(e => e + 1);
  };
  Object.assign(window, { integration: { reset, dashboard: () => { const st=useStore.getState(); useStore.setState({settings:{...st.settings,commandWall:{...st.settings!.commandWall!,dock:{...DEFAULT_WALL_STATE.dock,show:true,monitors:{vitals:true,utilization:true,budget:true,hardware:true,automations:false,insights:true}}}}} as any); setEpoch(e=>e+1); }, calls, failures, route: setRoute, state: () => useStore.getState(), records: () => records } });
  React.useEffect(reset, []);
  return <main style={{ height: '100vh' }} key={epoch}>{route === 'command' ? <CommandCenterView /> : route === 'settings' ? <UpdateProvider><SettingsView /></UpdateProvider> : <WorkspacesView sidebarOnly />}<Mascot mood="idle" enabled /></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
