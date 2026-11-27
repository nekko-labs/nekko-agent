import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ModelLibrary } from '../src/renderer/components/engine/ModelLibrary';
import type { LibraryModel } from '../src/renderer/components/engine/modelFamilies';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';

const GiB = 1024 ** 3;
const models: LibraryModel[] = [
  { id: 'qwen', name: 'Qwen3.8-27B-MLX-8bit', path: '/fixture/qwen', sizeBytes: 27.5 * GiB, addedAt: 2, loaded: false, format: 'mlx', mlxRunnable: true, modality: 'vision', parameterSize: '27B', quantization: '8-bit', maxContext: 262144, hasProjector: true, gpuFit: 'full', managed: false, folderProvider: 'lmstudio', preset: { contextTokens: 16384 } },
  { id: 'gemma', name: 'Gemma 3 4B', path: '/fixture/gemma', sizeBytes: 3.4 * GiB, addedAt: 1, loaded: false, modality: 'chat', parameterSize: '4B', quantization: 'Q4_K_M', maxContext: 32768, gpuFit: 'full', layers: 32 },
];
const state = { autoload: new Set<string>(), calls: [] as unknown[][] };
Object.assign(window, { cardFixture: state, nekko: {
  engineSetAutoload: async (id: string, on: boolean) => { state.calls.push(['start', id, on]); if (on) state.autoload.add(id); else state.autoload.delete(id); },
  runtimeLoad: async (...args: unknown[]) => { state.calls.push(['load', ...args]); return { ok: true }; },
  runtimePlace: async (_provider: string, _id: string, request: { contextTokens: number }) => ({
    verdict: 'fits', unified: true, deviceName: 'Fixture GPU', spareVramBytes: 32 * GiB,
    vram: { totalBytes: 64 * GiB, availBytes: 60 * GiB, otherBytes: 4 * GiB,
      model: { weightsBytes: 3.4 * GiB, kvCacheBytes: request.contextTokens * 240000, overheadBytes: .6 * GiB, pinnedBytes: 0 } },
    ram: { totalBytes: 0, availBytes: 0, otherBytes: 0, model: { weightsBytes: 0, kvCacheBytes: 0, overheadBytes: 0, pinnedBytes: 0 } },
    disk: { tableBytes: 0, overflowBytes: 0 },
  }),
  runtimeRecommend: async () => null,
} });
const actions = { ready: true, busy: false, isFavorite: () => false, isDefault: () => false, favorite: async () => {}, setDefault: async () => {}, remove: async () => {} };
function Fixture() {
  const [, refresh] = useState(0);
  return <main className="h-screen overflow-y-auto px-5 py-6"><div className="mx-auto max-w-4xl">
    <h1 className="mb-4 text-lg font-semibold">On this machine</h1>
    <ModelLibrary providerId="nekko-engine" models={models} canLoad actions={actions} onChanged={() => refresh(n => n + 1)} autoloadIds={new Set(state.autoload)} memory={{ kind: 'unified', budgetBytes: 64 * GiB }} />
  </div></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
