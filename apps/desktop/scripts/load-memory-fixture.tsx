import React from 'react';
import { createRoot } from 'react-dom/client';
import type { LocalModel, PlacementPlan, PlacementRequest } from '@nekko-agent/shared';
import { EngineLoadDrawer } from '../src/renderer/components/engine/EngineLoadDrawer';
import { ImageGeneration } from '../src/renderer/components/engine/ImageGeneration';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';

const GiB = 1024 ** 3;
const base = { name: '', path: '/fixture', sizeBytes: 6 * GiB, addedAt: 0, loaded: false, managed: true, maxContext: 131072 };
const models = {
  gguf: { ...base, id: 'gguf', name: 'Qwen 3 GGUF', format: 'gguf', modality: 'chat', layers: 32 },
  hermes: { ...base, id: 'hermes', name: 'Hermes 4 70B MLX', format: 'mlx', modality: 'chat', mlxRunnable: true, sizeBytes: 40 * GiB, mlxKvBytesPerToken: 327680 },
  partial: { ...base, id: 'partial', name: 'Qwen MLX (hybrid attention)', format: 'mlx', modality: 'chat', mlxRunnable: true, sizeBytes: 28 * GiB },
  image: { ...base, id: 'image', name: 'Qwen Image', format: 'gguf', modality: 'image', sizeBytes: 11 * GiB },
} satisfies Record<string, LocalModel & { loaded: boolean }>;
const pool = (total: number, weightsBytes = 0, kvCacheBytes = 0, overheadBytes = 0) =>
  ({ totalBytes: total, otherBytes: 4 * GiB, availBytes: total - 4 * GiB, model: { weightsBytes, kvCacheBytes, overheadBytes, pinnedBytes: 0 } });
Object.assign(window, { nekko: {
  runtimeRecommend: async () => null,
  runtimePlace: async (_provider: string, id: string, req: PlacementRequest): Promise<PlacementPlan> => ({
    verdict: id === 'gguf' ? 'fits' : 'unknown', unified: true, deviceName: 'Apple Silicon',
    vram: id === 'gguf' ? pool(64 * GiB, 6 * GiB, req.contextTokens * req.sessions * 65536, GiB) : pool(64 * GiB),
    ram: pool(64 * GiB), disk: { tableBytes: 0, overflowBytes: 0 }, spareVramBytes: 0,
  }),
  engineImageCompanions: async () => null,
  engineStatus: async () => ({ diffusionInstall: {} }),
  engineDownloads: async () => [],
  onDownloadsUpdated: () => () => {},
  getGpuStats: async () => ({ unified: true, totalMB: 65536, usedMB: 4096, freeMB: 61440 }),
  getSystemStats: async () => ({ memTotalMB: 65536, memUsedMB: 4096 }),
} });
const root = createRoot(document.getElementById('root')!);
const select = (id: keyof typeof models) => root.render(<main className="h-screen overflow-y-auto p-5">
  <div className="mx-auto max-w-2xl">
    {id === 'image' ? <ImageGeneration model={models[id]} onChanged={() => {}} />
      : <EngineLoadDrawer key={id} providerId="nekko-engine" model={models[id]} onDone={() => {}} onClose={() => {}} />}
  </div>
</main>);
Object.assign(window, { loadMemoryFixture: { select } });
select('gguf');
