// Synthetic model/runtime download controls. No host or external downloads.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ModelDetail } from '../src/renderer/components/engine/ModelDetail';
import { EngineInstallCard } from '../src/renderer/components/engine/EngineInstallCard';
import { DiffusionInstallCard } from '../src/renderer/components/engine/DiffusionInstallCard';
import { MlxInstallCard } from '../src/renderer/components/engine/MlxInstallCard';
import { RecommendationList } from '../src/renderer/components/engine/RecommendedModels';
import { DecisionModels } from '../src/renderer/components/engine/DecisionModels';
import recommendationFixtures from '../src/renderer/components/engine/recommendations.fixture.json';
import '../src/renderer/styles.css';
let jobs: any[] = [];
const listeners = new Set<(jobs: any[]) => void>();
const calls: Record<string, number> = {};
const build = { id: 'fixture-metal', backend: 'metal', requires: 'Apple Silicon', platform: 'darwin', arch: 'arm64' };
const install = { available: [build], recommended: build };
const model = { id: 'fixture/Qwen3-GGUF', name: 'Qwen3 8B', owner: 'fixture', quants: [{ label: 'Q4_K_M', file: 'qwen-Q4_K_M.gguf', sizeBytes: 5000000000 }], tags: [], siblings: [] };
const emit = (state: string, pct?: number) => { jobs = jobs.map(j => ({ ...j, state, receivedBytes: pct === undefined ? 0 : pct * 1000000, totalBytes: pct === undefined ? undefined : 100000000 })); listeners.forEach(f => f(jobs)); };
const request = async (kind: string, key: string, runtime?: string) => {
  calls[key] = (calls[key] || 0) + 1;
  // Hold the response to prove immediate locking before the first job arrives.
  await new Promise(r => setTimeout(r, 350));
  jobs = [...jobs.filter(j => j.id !== key), { id: key, kind, label: key, target: runtime || model.id, group: key.startsWith('decision:') ? key : undefined, state: 'queued', receivedBytes: 0, startedAt: Date.now() }];
  listeners.forEach(f => f(jobs));
  return { ok: true, message: 'Download queued.' };
};
const bridge = {
  engineDownloads: async () => jobs,
  onDownloadsUpdated: (fn: (jobs: any[]) => void) => { listeners.add(fn); return () => listeners.delete(fn); },
  engineCatalogDetail: async () => model,
  engineInstallPreview: async () => ({ build, version: 'b9999', sizeBytes: 100000000, files: [] }),
  engineDownloadModel: async () => request('model', 'model:fixture/Qwen3-GGUF:Q4_K_M'),
  engineInstall: async (_id?: string, runtime = 'llama') => request('engine', `engine:${runtime}:fixture-metal`, runtime),
  decisionsCatalog: async () => [{ id: 'laya', name: 'Laya', description: 'Synthetic decision model', license: 'Apache-2.0', publisher: 'Fixture', variants: [{ precision: 'fp16', bytes: 100000000, recommended: true }], shared: [] }],
  decisionsModels: async () => [], decisionsStatus: async () => null,
  decisionsDownload: async () => request('model', 'decision:laya:fp16'),
  engineStatus: async () => ({ install, diffusionInstall: install }),
};
Object.assign(window, { nekko: bridge, downloadFixture: { emit, calls } });
const noop = () => {};
const recs = { ...recommendationFixtures.m5max, tasks: [ { ...recommendationFixtures.m5max.tasks[0], pick: { ...recommendationFixtures.m5max.tasks[0].pick, repo: model.id, downloadLabel: 'Q4_K_M' } } ] };

createRoot(document.getElementById('root')!).render(<main className="bg-paper min-h-screen p-5 text-ink"><div className="mx-auto max-w-4xl space-y-4"><h1 className="text-xl font-semibold">Model server</h1><div data-fixture="model"><ModelDetail embedded modelId={model.id} installed={[]} onBack={noop} onQueued={noop} /></div><div data-fixture="llama"><EngineInstallCard install={install as any} onChanged={noop} /></div><div className="card p-4"><div data-fixture="diffusion"><DiffusionInstallCard install={install as any} onChanged={noop} /></div><div data-fixture="mlx"><MlxInstallCard install={install as any} onChanged={noop} /></div></div><div className="card p-4" data-fixture="recommendation"><RecommendationList recs={recs as any} models={[]} open onDownload={noop} onRecheck={noop} /></div><div className="card p-4" data-fixture="decision"><DecisionModels /></div></div></main>);
