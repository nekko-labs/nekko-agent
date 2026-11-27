import './wall-polish-chrome';
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../src/renderer/store';
import { CommandCenterView } from '../src/renderer/views/CommandCenterView';
import { ModelServerView } from '../src/renderer/views/ModelServerView';
import { DEFAULT_WALL_STATE } from '../src/renderer/commandWall';
import '../src/renderer/styles.css';

// Synthetic records only. This fixture never connects to a host, daemon or engine.
const provider = { id: 'nekko-engine', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11500/v1', enabled: true, label: 'Nekko Agent engine', auth: 'none' };
const GB = 1024 ** 3;
const now = Date.now();
const library = [
  { id: 'qwen3-8b-q4', name: 'Qwen3 8B Q4_K_M', path: '/fixture/qwen3-8b.gguf', format: 'gguf', sizeBytes: 5 * GB, quantization: 'Q4_K_M', parameterSize: '8B', layers: 36, maxContext: 131072, modality: 'chat', addedAt: now },
  { id: 'gemma3-27b-q4', name: 'Gemma 3 27B Q4_K_M', path: '/fixture/gemma3-27b.gguf', format: 'gguf', sizeBytes: 16 * GB, quantization: 'Q4_K_M', parameterSize: '27B', layers: 62, maxContext: 131072, modality: 'chat', addedAt: now },
  { id: 'flux1-schnell-q4', name: 'FLUX.1 schnell Q4_K', path: '/fixture/flux1-schnell.gguf', format: 'gguf', sizeBytes: 6.8 * GB, quantization: 'Q4_K', parameterSize: '12B', modality: 'image', addedAt: now },
  { id: 'phi4-mini-q4', name: 'Phi 4 mini Q4_K_M', path: '/fixture/phi4-mini.gguf', format: 'gguf', sizeBytes: 2.5 * GB, quantization: 'Q4_K_M', parameterSize: '3.8B', layers: 32, maxContext: 131072, modality: 'chat', addedAt: now },
];
// The reported case: a chat model and a picture model in memory at once.
const RESIDENT = [
  { id: 'gemma3-27b-q4', sizeBytes: 16 * GB, vramBytes: 9.8 * GB, contextLength: 16384, gpuLayers: 38, totalLayers: 62, loadedOn: 'gpu+cpu', lastUsedAt: now - 5_000, startedAt: now - 120_000 },
  { id: 'flux1-schnell-q4', sizeBytes: 6.8 * GB, vramBytes: 8.1 * GB, loadedOn: 'gpu', lastUsedAt: now - 30_000, startedAt: now - 600_000, expiresAt: now + 840_000 },
];
let resident = [...RESIDENT];
const settings = { port: 11500, bind: 'local', autoStart: true, jitLoad: true, idleTtlSeconds: 900, maxLoaded: 2, autoload: [] };
let empty = false;
const status = () => ({
  install: { binPath: '/fixture/llama-server', version: 'b0000', available: [] },
  running: true, startedAt: now - 3_600_000, resident: empty ? [] : resident, loading: [], log: [], port: 11500, settings,
  memory: { budgetBytes: 16 * GB, kind: 'vram' },
});
const bridge: any = {
  engineStatus: async () => status(), engineModels: async () => library.map((m) => ({ ...m, loaded: resident.some((r) => r.id === m.id) })),
  unloadModel: async (_p: string, id: string) => { resident = resident.filter((r) => r.id !== id); return { ok: true }; },
  runtimeLoad: async (_p: string, id: string) => { resident = [...resident, { id, sizeBytes: 5 * GB, loadedOn: 'gpu', lastUsedAt: Date.now(), startedAt: Date.now() }]; return { ok: true }; }, engineDownloads: async () => [], engineCatalog: async () => [], listModelFolders: async () => [],
  listSessionSummaries: async () => [], listTerminals: async () => [], listTasks: async () => [], runningSessions: async () => [], pendingInput: async () => ({}),
  getSystemStats: async () => ({ cpuPct: 23, memUsedMB: 18432, memTotalMB: 32768 }),
  getGpuStats: async () => ({ totalMB: 16384, usedMB: 16000, devices: [{ name: 'Fixture RTX 4080', utilizationPct: 64, totalMB: 16384, usedMB: 16000 }] }),
  getUsageSummary: async () => null, listModels: async () => [], getAppInfo: async () => ({ version: '0.0.0-fixture', platform: 'darwin' }), getUpdateInfo: async () => null,
  updateSettings: async (patch: any) => ({ ...useStore.getState().settings, ...patch }),
  engineFitPlan: async () => null, decisionsCatalog: async () => [], decisionsModels: async () => [], engineAutofit: async () => null, gpuFitFor: async () => null,
};
Object.assign(window, { nekko: new Proxy(bridge, { get(target, key: string) { if (key in target) return target[key]; if (key.startsWith('on')) return () => () => {}; return () => Promise.resolve(null); } }) });

function Fixture() {
  const [epoch, setEpoch] = useState(0);
  const view = useStore((s) => s.view);
  const reset = (opts: { empty?: boolean; side?: 'right' | 'bottom' } = {}) => {
    empty = !!opts.empty;
    resident = [...RESIDENT];
    localStorage.clear();
    // Phi was in memory an hour ago: it is Recent.
    localStorage.setItem('nekko.localModels.recent', JSON.stringify([{ id: 'phi4-mini-q4', at: now - 3_600_000 }]));
    const dock = { ...DEFAULT_WALL_STATE.dock, show: true, simpleShow: true, side: opts.side ?? 'right', monitorOrder: ['hardware', 'localModels', 'utilization', 'budget', 'automations'], monitors: { hardware: true, localModels: true, utilization: false, budget: false, automations: false } };
    useStore.setState({ view: 'command', providers: [provider], models: [], activeProviderId: null, sessions: [], terminals: [], workspaces: [], activeWorkspaceId: null, activeSessionId: null, activeProjectId: null, settings: { providers: [provider], workspaceFolders: [], workspaces: [], monitors: { cpu: true, memory: true, gpu: true, vram: true }, theme: 'dark', experimental: {}, agent: {}, ui: {}, favoriteModels: ['nekko-engine::qwen3-8b-q4'], commandWall: { ...DEFAULT_WALL_STATE, zonesIntro: true, root: null, hero: null, autoAdd: false, watermark: Date.now(), dock } }, activeSkillBySession: {}, prsBySession: {}, installedSkillDefs: [], contextPanelOpen: false } as any);
    setEpoch((e) => e + 1);
  };
  Object.assign(window, { integration: { reset, state: () => useStore.getState() } });
  React.useEffect(reset, []);
  return <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }} className="bg-paper" key={epoch}>
    <main style={{ flex: 1, minHeight: 0 }}>{view === 'modelserver' ? <ModelServerView /> : <CommandCenterView />}</main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
