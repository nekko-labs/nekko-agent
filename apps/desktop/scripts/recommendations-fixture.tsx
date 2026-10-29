import './wall-polish-chrome';
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../src/renderer/store';
import { ModelServerView } from '../src/renderer/views/ModelServerView';
import '../src/renderer/styles.css';
// What the daemon answers for reference machines (`machine:recommendations`), aliased by the integration script.
import data from 'recommendations-fixture-data';

// Synthetic records only. This fixture never connects to a host, daemon or engine.
const provider = { id: 'nekko-engine', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11500/v1', enabled: true, label: 'Nekko Agent engine', auth: 'none' };
const GB = 1024 ** 3;
const MEMORY: Record<string, { budgetBytes: number; kind: 'vram' | 'unified' | 'ram' }> = {
  m5max: { budgetBytes: 128 * GB, kind: 'unified' },
  'm5max-here': { budgetBytes: 128 * GB, kind: 'unified' },
  rtx4080upgrade: { budgetBytes: 16 * GB, kind: 'vram' },
  rtx4060: { budgetBytes: 8 * GB, kind: 'vram' },
  cpu: { budgetBytes: 16 * GB, kind: 'ram' },
};
const catalog = [
  { id: 'unsloth/Qwen3-4B-GGUF', name: 'Qwen3 4B', owner: 'Qwen', parameterSize: '4B', tags: ['chat'], curated: true, recommended: true, quants: [{ label: 'Q4_K_M', file: 'Qwen3-4B-Q4_K_M.gguf', sizeBytes: 2.5e9 }] },
  { id: 'bartowski/Qwen2.5-Coder-7B-Instruct-GGUF', name: 'Qwen2.5 Coder 7B', owner: 'Qwen', parameterSize: '7B', tags: ['code'], curated: true, quants: [{ label: 'Q4_K_M', file: 'Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf', sizeBytes: 4.7e9 }] },
  { id: 'CompendiumLabs/bge-small-en-v1.5-gguf', name: 'BGE Small (embeddings)', owner: 'BAAI', parameterSize: '33M', tags: ['embedding'], curated: true, quants: [{ label: 'F16', file: 'bge-small-en-v1.5-f16.gguf', sizeBytes: 6.7e7 }] },
];
let machine = 'm5max';
let library: any[] = [];
const settings = { port: 11500, bind: 'local', autoStart: true, jitLoad: true, idleTtlSeconds: 900, maxLoaded: 2, autoload: [] };
const status = () => ({
  install: { binPath: '/fixture/llama-server', version: 'b0000', backend: 'metal', available: [] },
  running: true, startedAt: Date.now() - 3_600_000, resident: [], loading: [], log: [], port: 11500, settings, memory: MEMORY[machine],
});
const downloads: string[] = [];
const dismissed: string[] = [];
const bridge: any = {
  engineStatus: async () => status(), engineModels: async () => library, engineDownloads: async () => [], engineCatalog: async () => catalog,
  listModelFolders: async () => [], getAppInfo: async () => ({ version: '0.0.0-fixture', platform: 'darwin' }),
  machineDismissNudge: async () => { dismissed.push('all'); return { ok: true }; },
  machineRecommendations: async () => {
    if (machine !== 'm5max-here') return (data as any)[machine];
    // The coding pick after a dozen replies on this machine.
    const r = structuredClone((data as any).m5max);
    r.tasks.find((t: any) => t.task === 'code').pick.speed = { tokensPerSecond: 98.4, basis: 'measuredHere', samples: 12 };
    return r;
  },
  engineDownloadModel: async (repo: string, label: string) => { downloads.push(`${repo} ${label}`); return { ok: true, message: 'Queued', jobId: 'job-1' }; },
  updateSettings: async (patch: any) => ({ ...useStore.getState().settings, ...patch }),
};
Object.assign(window, { nekko: new Proxy(bridge, { get(target, key: string) { if (key in target) return target[key]; if (key.startsWith('on')) return () => () => {}; return () => Promise.resolve(null); } }) });

function Fixture() {
  const [epoch, setEpoch] = useState(0);
  const reset = (opts: { machine?: string; library?: any[] } = {}) => {
    machine = opts.machine ?? 'm5max';
    library = opts.library ?? [];
    localStorage.clear();
    useStore.setState({ view: 'modelserver', providers: [provider], models: [], activeProviderId: null, sessions: [], terminals: [], workspaces: [], activeWorkspaceId: null, activeSessionId: null, activeProjectId: null, settings: { providers: [provider], workspaceFolders: [], workspaces: [], monitors: {}, theme: 'dark', experimental: {}, agent: {}, ui: {} }, activeSkillBySession: {}, prsBySession: {}, installedSkillDefs: [], contextPanelOpen: false } as any);
    setEpoch((e) => e + 1);
  };
  Object.assign(window, { integration: { reset, downloads, dismissed, data } });
  React.useEffect(reset, []);
  return <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }} className="bg-paper" key={epoch}>
    <main style={{ flex: 1, minHeight: 0 }}><ModelServerView /></main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
