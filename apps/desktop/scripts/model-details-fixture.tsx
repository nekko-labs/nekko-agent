import React from 'react';
import { createRoot } from 'react-dom/client';
import { ModelsHome } from '../src/renderer/components/engine/ModelsHome';
import type { EngineSettings, LocalModel, PlacementRequest } from '@nekko-agent/shared';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';

// Renderer-only recreation of the reported configuration. No real engine or profile.
const GiB = 1024 ** 3;
const model: LocalModel & { loaded: boolean; gpuFit: 'full' } = {
  id: 'inkling', name: 'Inkling-2-Mini-Unbound', path: '/fixture/inkling.gguf', format: 'gguf',
  sizeBytes: 25.9 * GiB, layers: 24, maxContext: 1048576, quantization: 'Q8_0', modality: 'chat',
  sourceRepo: 'fixture/Inkling-2-Mini-Unbound-GGUF', addedAt: 0, loaded: false, gpuFit: 'full',
};
const place = (r: PlacementRequest) => ({
  verdict: 'fits', unified: true, deviceName: 'Apple M1 Max', spareVramBytes: 10 * GiB,
  vram: { totalBytes: 64 * GiB, availBytes: 52 * GiB, otherBytes: 12 * GiB, model: {
    weightsBytes: model.sizeBytes, kvCacheBytes: (8192 * r.contextTokens + 40960 * Math.min(1536, r.contextTokens)) * r.sessions * 34 / 32,
    overheadBytes: 352 * 1024 ** 2, pinnedBytes: 0,
  } },
  ram: { totalBytes: 64 * GiB, availBytes: 52 * GiB, otherBytes: 12 * GiB, model: { weightsBytes: 0, kvCacheBytes: 0, overheadBytes: 0, pinnedBytes: 0 } },
  disk: { tableBytes: 0, overflowBytes: 0 },
});
const baseline = new URL(location.href).pathname.includes('model-details-before');
const request: PlacementRequest = { runOn: 'gpu', contextTokens: 262144, sessions: baseline ? 4 : 1, kvCacheDtype: 'q8_0', gpuLayers: 24, cpuMoeLayers: 0, cpuFfnLayers: 0, kvOnGpu: true, mmap: true, pin: false, tablesOnDisk: true, moeCacheBytes: 0 };
const why = [
  { field: 'Run on', value: 'GPU', sentence: 'Your Mac shares one pool of memory between the GPU and the CPU.' },
  { field: 'Context', value: '256K per session', sentence: baseline ? 'The most that fits beside the model. Lower it to free memory.' : 'Recommended for this setup. Lower it to free memory.' },
  { field: 'Sessions at once', value: String(request.sessions), sentence: baseline ? 'Room for agents and chats to answer at the same time, each with its full context.' : 'A safer starting point on shared memory. More simultaneous requests can slow replies and use more memory.' },
];
const bridge = {
  machineRecommendations: async () => null, engineCatalog: async () => [], engineModelDetail: async () => null,
  runtimePlace: async (_p: string, _m: string, r: PlacementRequest) => place(r),
  runtimeRecommend: async () => ({ request, plan: place(request), why }),
};
Object.assign(window, { nekko: new Proxy(bridge, { get(target, key: string) { return Reflect.get(target, key) ?? (key.startsWith('on') ? () => () => {} : async () => null); } }), detailFixture: { theme: (name: string) => { document.documentElement.dataset.theme = name; } } });
createRoot(document.getElementById('root')!).render(<main className="mx-auto h-screen max-w-7xl overflow-y-auto p-6">
  <h1 className="mb-4 text-xl font-semibold">On this machine</h1>
  <ModelsHome providerId="nekko-engine" mode="installed" models={[model]} canLoad resident={[]} settings={{ autoload: [] } as unknown as EngineSettings} memory={{ kind: 'unified', budgetBytes: 64 * GiB }} onChanged={() => {}} />
</main>);
