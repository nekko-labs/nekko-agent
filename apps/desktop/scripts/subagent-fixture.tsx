import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../src/renderer/store';
import { putCachedSession, __resetSessionCache } from '../src/renderer/sessionCache';
import { CommandCenterView } from '../src/renderer/views/CommandCenterView';
import { StoreSidebar } from './store-sidebar';
import { DEFAULT_WALL_STATE } from '../src/renderer/commandWall';
import { summarizeSession } from '@nekko-agent/shared';
import '../src/renderer/styles.css';

// Synthetic records only. This fixture never connects to a host or daemon.
const provider = { name: 'Fixture provider', id: 'fixture', kind: 'openai', enabled: true, label: 'Fixture provider' };
const models = [{ id: 'fixture-model', providerId: 'fixture', name: 'Fixture model', contextWindow: 128000 }, { id:'fixture-fast',providerId:'fixture',name:'Fast fixture',contextWindow:32000 }];
const messages = [
  ...Array.from({length:80},(_,i)=>({id:`old-${i}`,role:i%2?'assistant':'user',createdAt:i,content:`Earlier conversation ${i}. A retained transcript row for scrolling verification.`})),
  {id:'watch',role:'user',createdAt:81,content:'[Agent watch fixture]\nChecks changed. Inspect the latest results.'},
  {id:'ordinary',role:'user',createdAt:82,content:'Please check the integration and report back.'},
  {id:'delegate',role:'assistant',createdAt:83,content:'',toolCalls:[
    {id:'success',name:'spawn_agent',input:{title:'Integration tests',task:'Run the integration checks.'}},
    {id:'failure',name:'spawn_agent',input:{title:'Platform check',task:'Check the unavailable platform.'}},
    {id:'missing',name:'spawn_agent',input:{title:'Pending evidence',task:'Inspect remaining evidence.'}}
  ]},
  {id:'ok',role:'tool',createdAt:84,content:'All integration checks passed.',toolResult:{toolCallId:'success',output:'All integration checks passed.'}},
  {id:'err',role:'tool',createdAt:85,content:'Platform unavailable in the fixture.',toolResult:{toolCallId:'failure',output:'Platform unavailable in the fixture.',isError:true}},
  {id:'final',role:'assistant',createdAt:86,content:'Integration passed; platform evidence is unavailable.'},
];
const makeSession = (id: string) => ({ id, title: id === 'existing' ? 'Existing conversation' : `Synthetic ${id}`, createdAt: Date.now(), updatedAt: Date.now(), providerId: 'fixture', modelId: 'fixture-model', mode: 'agent', chatType: 'multimodal', messages, attachments: [], queuedPrompts: [] });
let pending: any = {};
const listeners = new Set<(e: any) => void>();
let records: any[] = [];
let terminals: any[] = [];
let serial = 0;
const calls: any[] = [];
const failures = { create: false, options: false, cleanup: false, send: false };
let nextWakeAt: number | null = null;
const bridge: any = {
  createSession: async (workspaceId: string) => { calls.push({ method: 'create', workspaceId }); if (failures.create) throw Error('Synthetic creation failure'); const s = { ...makeSession(`new-${++serial}`), workspaceId }; records.push(s); return s; },
  setSessionOptions: async (id: string, options: any) => { calls.push({ method: 'options', id, options }); if (failures.options) throw Error('Synthetic options failure'); const s = records.find(s => s.id === id); Object.assign(s, options); sessionStorage.setItem('fixture-record', JSON.stringify(s)); return {...s}; },
  deleteSession: async (id: string) => { calls.push({ method: 'cleanup', id }); if (failures.cleanup) throw Error('Synthetic cleanup failure'); records = records.filter(s => s.id !== id); },
  createTerminal: async (options: any) => { calls.push({ method: 'terminal', options }); const t = { id: `terminal-${++serial}`, title: 'Synthetic terminal', cwd: '/synthetic', running: false }; terminals.push(t); return t; },
  listSessionSummaries: async () => records.map(summarizeSession), listTerminals: async () => terminals,
  getSession: async (id: string) => records.find(s => s.id === id), listModels: async () => models,
  getUsageSummary: async () => null, pendingInput: async () => pending, onAgentEvent: (fn: any) => {listeners.add(fn);return () => listeners.delete(fn)}, answerQuestion: async (id: string, callId: string, answers: any) => {calls.push({method:'answer',id,callId,answers});pending={};listeners.forEach(fn=>fn({type:'question_resolved',sessionId:id,callId}));}, runningSessions: async () => [],
  nextAgentWatchAt: async (id: string) => { calls.push({method:'nextWake',id}); return nextWakeAt; },
  sendChat: async (input: any) => { calls.push({method:'send',input}); if (failures.send) { listeners.forEach(fn=>fn({type:'error',sessionId:input.sessionId,message:'Synthetic request failure'})); return; } const s=records.find(s=>s.id===input.sessionId); if(s && input.text) { s.messages=[...s.messages,{id:`sent-${++serial}`,role:'user',content:input.text,createdAt:Date.now()}]; listeners.forEach(fn=>fn({type:'message',sessionId:input.sessionId,message:s.messages.at(-1)})); } listeners.forEach(fn=>fn({type:'done',sessionId:input.sessionId})); },
  listTasks: async () => [], listShells: async () => [], listChanges: async () => [], listFiles: async () => [],
  previewContext: async () => ({ items: [], totalTokens: 0, budget: 128000 }), getGitStatus: async () => ({ repo: false }),
  getLimits: async () => null, listTools: async () => [], getMcpStatus: async () => [], listSkills: async () => [],
  terminalRead: async () => '', readTerminal: async () => '', updateSettings: async () => null,
};
Object.assign(window, { nekko: new Proxy(bridge, { get(target, key: string) { if (key in target) return target[key]; if (key.startsWith('on')) return () => () => {}; return () => Promise.resolve(null); } }) });
function Fixture() {
  const [epoch, setEpoch] = useState(0);
  const [route, setRoute] = useState('command');
  const reset = () => {
    records = [JSON.parse(sessionStorage.getItem('fixture-record') || 'null') || makeSession('existing')]; __resetSessionCache(); pending = {}; terminals = []; serial = 0; calls.length = 0; nextWakeAt = null;
    Object.assign(failures, { create: false, options: false, cleanup: false, send: false });
    localStorage.clear();
    useStore.setState({ providers: [provider], models, activeProviderId: 'fixture', sessions: records.map(summarizeSession), terminals: [], workspaces: [], activeWorkspaceId: null, activeSessionId: null, activeProjectId: 'synthetic-project', settings: { providers: [provider], workspaceFolders: [], workspaces: [], theme: 'light', experimental: {}, agent: {}, ui: {}, commandWall: { ...DEFAULT_WALL_STATE, zonesIntro: true, root: { id: 'synthetic-pane', kind: 'chat', refId: 'existing' }, autoAdd: false, watermark: Date.now(), dock: { ...DEFAULT_WALL_STATE.dock, show: false } } }, activeSkillBySession: {}, prsBySession: {}, installedSkillDefs: [], contextPanelOpen: false, planRailOpen: false } as any);
    setRoute('command'); setEpoch(e => e + 1);
  };
  Object.assign(window, { integration: { reset, ask: () => { const request = {callId:'ask-fixture',askedAt:Date.now(),questions:[{id:'choice',header:'Choice',question:'Which verification path?',options:[{label:'Focused tests'},{label:'Full suite'}]}]}; pending={existing:{question:request}}; listeners.forEach(fn=>fn({type:'question',sessionId:'existing',request})); }, calls, failures, wake: (at: number | null) => { nextWakeAt = at; listeners.forEach(fn=>fn({type:'tool_result',sessionId:'existing'})); }, restore: () => { sessionStorage.removeItem('fixture-record'); reset(); }, clean: () => { const s=makeSession('existing'); s.messages = [{id:'clean-user',role:'user',content:'Ready for another turn',createdAt:1},{id:'clean-answer',role:'assistant',content:'Ready.',createdAt:2}]; sessionStorage.setItem('fixture-record',JSON.stringify(s)); reset(); }, route: setRoute, state: () => useStore.getState(), inbox: (text: string) => useStore.setState({composerInbox:{sessionId:'existing',text,run:true}}), records: () => records } });
  React.useEffect(reset, []);
  return <main style={{ height: '100vh' }} key={epoch}>{route === 'command' ? <CommandCenterView /> : <StoreSidebar />}</main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
