import './wall-polish-chrome';
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../src/renderer/store';
import { putCachedSession } from '../src/renderer/sessionCache';
import { clearLiveRun } from '../src/renderer/liveRuns';
import { ChatPane } from '../src/renderer/components/ChatPane';
import '../src/renderer/styles.css';

// Synthetic records only. This fixture never connects to a host or daemon.
//
// A short chat with a filled context window, fixed hardware readings and two
// models resident on the Model Server, for the Simple / Expert evidence.
const provider = { id: 'fixture', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', enabled: true, label: 'Fixture provider', auth: 'subscription', tokenKey: 'fixture' };
const models = [{ id: 'claude-opus-5-5', providerId: 'fixture', name: 'Claude Opus 5.5', contextWindow: 200000, contextLength: 200000 }];
const at = Date.now() - 3_600_000;

function makeSession() {
  const messages = [
    { id: 'u0', role: 'user', content: 'Why does the build cache miss on every CI run?', createdAt: at },
    { id: 'a0', role: 'assistant', content: 'The cache key includes the lockfile hash **and** the runner image date, so a new image each night misses it. Key it on the lockfile alone and restore with a prefix fallback.', createdAt: at + 5000 },
  ];
  return { id: 'alpha', title: 'CI cache misses', createdAt: at, updatedAt: at, providerId: 'fixture', modelId: 'claude-opus-5-5', effort: 'high', mode: 'agent', chatType: 'multimodal', messages, attachments: [], queuedPrompts: [] };
}

let record: any = makeSession();
const bridge: any = {
  getSession: async () => record, listModels: async () => models, listSessionSummaries: async () => [], listTerminals: async () => [],
  getUsageSummary: async () => ({ totalInput: 0, totalOutput: 0, totalCost: 0, byModel: {}, byProvider: {}, bySession: {}, bySessionCost: {}, daily: [] }),
  pendingInput: async () => ({}), runningSessions: async () => [], listTasks: async () => [], listShells: async () => [], listChanges: async () => [], listFiles: async () => [],
  previewContext: async () => ({ contextWindow: 200000, items: [
    { id: 's', source: 'system', label: 'System prompt', tokens: 9200, included: true },
    { id: 'g', source: 'guideline', label: 'AGENTS.md', tokens: 3100, included: true },
    { id: 'c', source: 'conversation', label: 'Conversation', tokens: 112400, included: true },
  ] }),
  getSystemStats: async () => ({ cpuPct: 38, cpuCores: 16, memUsedMB: 41000, memTotalMB: 65536, temps: { cpuC: 64 } }),
  getGpuStats: async () => ({ source: 'nvidia-smi', totalMB: 24576, usedMB: 19800, freeMB: 4776, devices: [{ name: 'RTX 4090', memoryTotalMB: 24576, memoryUsedMB: 19800, memoryFreeMB: 4776, utilizationPct: 91, temperatureC: 83 }] }),
  engineStatus: async () => ({ install: { binPath: '/fixture/llama-server' }, running: true, resident: [
    { id: 'qwen3-coder-30b', vramBytes: 17.2e9, contextLength: 65536, loadedOn: 'gpu', gpuLayers: 48, totalLayers: 48 },
    { id: 'gemma-4-e4b', vramBytes: 2.4e9, contextLength: 32768, loadedOn: 'gpu+cpu', gpuLayers: 20, totalLayers: 34 },
  ], loading: [] }),
  engineModels: async () => [{ id: 'qwen3-coder-30b', name: 'Qwen3 Coder 30B' }, { id: 'gemma-4-e4b', name: 'Gemma 4 E4B' }], getGitStatus: async () => ({ repo: false }),
  getAppInfo: async () => ({ version: '0.0.0-fixture', platform: 'win32' }), getUpdateInfo: async () => null,
  listTools: async () => [], getMcpStatus: async () => [], listSkills: async () => [], getLimitsProblem: async () => null, getLimits: async () => null,
  nextAgentWatchAt: async () => null,
  setSessionOptions: async (_id: string, patch: any) => { record = { ...record, ...patch }; putCachedSession(record); return record; },
  updateSettings: async (patch: any) => ({ ...useStore.getState().settings, ...patch }),
};
Object.assign(window, { nekko: new Proxy(bridge, { get(target, key: string) { if (key in target) return target[key]; if (key.startsWith('on')) return () => () => {}; return () => Promise.resolve(null); } }) });

function Fixture() {
  const [epoch, setEpoch] = useState(0);
  const reset = () => {
    clearLiveRun('alpha');
    record = makeSession();
    // The sandbox picks the mode before a reset; keep it.
    useStore.setState({ view: 'chat', providers: [provider], models, activeProviderId: 'fixture', sessions: [], terminals: [], workspaces: [], activeWorkspaceId: null, activeSessionId: 'alpha', activeProjectId: null, settings: { providers: [provider], workspaceFolders: [], workspaces: [], theme: 'dark', effort: 'normal', experimental: {}, agent: {}, ui: {} }, activeSkillBySession: {}, prsBySession: {}, installedSkillDefs: [], contextPanelOpen: false, planRailOpen: false, paletteOpen: false } as any);
    putCachedSession(record);
    setEpoch(e => e + 1);
  };
  Object.assign(window, { integration: { reset } });
  React.useEffect(() => reset(), []);
  return <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }} className="bg-paper" key={epoch}>
    <main style={{ flex: 1, minHeight: 0 }}><ChatPane sessionId="alpha" /></main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
