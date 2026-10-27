import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../src/renderer/store';
import { putCachedSession } from '../src/renderer/sessionCache';
import { CommandCenterView } from '../src/renderer/views/CommandCenterView';
import { StoreSidebar } from './store-sidebar';
import { Toasts } from '../src/renderer/components/Toasts';
import { Mascot } from '../src/renderer/components/Mascot';
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
const failures = { create: false, options: false, cleanup: false, terminal: false, delay: 0 };
const bridge: any = {
  createSession: async (workspaceId: string) => { calls.push({ method: 'create', workspaceId }); if (failures.delay) await new Promise(resolve => setTimeout(resolve, failures.delay)); if (failures.create) throw Error('Synthetic creation failure'); const s = { ...makeSession(`new-${++serial}`), workspaceId }; records.push(s); return s; },
  setSessionOptions: async (id: string, options: any) => { calls.push({ method: 'options', id, options }); if (failures.options) throw Error('Synthetic options failure'); const s = records.find(s => s.id === id); Object.assign(s, options); return {...s}; },
  abortChat: async (id: string) => { calls.push({ method: 'abort', id }); },
  setSessionWorkspace: async (id: string, workspaceId?: string) => { calls.push({ method: 'workspace', id, workspaceId }); Object.assign(records.find(s => s.id === id), { workspaceId }); },
  deleteSession: async (id: string) => { calls.push({ method: 'cleanup', id }); if (failures.cleanup) throw Error('Synthetic cleanup failure'); records = records.filter(s => s.id !== id); },
  createTerminal: async (options: any) => { calls.push({ method: 'terminal', options }); if (failures.terminal) throw Error('Synthetic terminal failure'); const t = { workspaceId: options.workspaceId, id: `terminal-${++serial}`, title: 'Synthetic terminal', cwd: '/synthetic', running: false }; terminals.push(t); return t; },
  listSessionSummaries: async () => records.map(summarizeSession), listTerminals: async () => terminals,
  getSession: async (id: string) => records.find(s => s.id === id), listModels: async () => models,
  getUsageSummary: async () => null, pendingInput: async () => ({}), runningSessions: async () => [],
  listTasks: async () => [], listShells: async () => [], listChanges: async () => [], listFiles: async () => [],
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
    Object.assign(failures, { create: false, options: false, cleanup: false, terminal: false, delay: 0 });
    localStorage.clear();
    useStore.setState({ toasts: [], view: 'command', providers: [provider], models, activeProviderId: 'fixture', sessions: records.map(summarizeSession), terminals: [], workspaces: [], activeWorkspaceId: null, activeSessionId: null, activeProjectId: 'synthetic-project', settings: { providers: [provider], workspaceFolders: [], workspaces: [], theme: 'light', experimental: {}, agent: {}, ui: {}, commandWall: { ...DEFAULT_WALL_STATE, zonesIntro: true, root: { id: 'synthetic-pane', kind: 'chat', refId: 'existing' }, autoAdd: false, watermark: Date.now(), dock: { ...DEFAULT_WALL_STATE.dock, show: false } } }, activeSkillBySession: {}, prsBySession: {}, installedSkillDefs: [], contextPanelOpen: false, planRailOpen: false } as any);
    records.forEach(putCachedSession); setRoute('command'); setEpoch(e => e + 1);
  };
  Object.assign(window, { integration: { reset, configureWall: async (wall: any) => { setRoute('blank'); await new Promise(resolve => setTimeout(resolve, 100)); localStorage.clear(); const state = useStore.getState(); useStore.setState({settings:{...state.settings, commandWall:{zonesIntro:true,...wall}}} as any); setEpoch(e=>e+1); setRoute('command'); }, dashboard: () => { const st=useStore.getState(); useStore.setState({settings:{...st.settings,commandWall:{...st.settings!.commandWall!,dock:{...DEFAULT_WALL_STATE.dock,show:true,monitors:{vitals:true,utilization:true,budget:true,hardware:true,automations:false,insights:true}}}}} as any); setEpoch(e=>e+1); }, calls, failures, route: setRoute, state: () => useStore.getState(), records: () => records } });
  React.useEffect(reset, []);
  return <main style={{ height: '100vh' }} key={epoch}>{route === 'blank' ? null : route === 'command' ? <CommandCenterView /> : <StoreSidebar />}<Toasts /><Mascot mood="idle" enabled /></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
