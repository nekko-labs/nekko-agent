// The Models page (real ModelsHome) against a stub bridge: an RTX 4060 with no
// models yet, the chat recommendations from the shared fixture plus the
// picture picks, a catalog of the usual chat starters, and for any search the
// kind of picture repos Hugging Face returns: the set-up one, two from known
// publishers, a remix from an unknown one and a barely downloaded one. Never
// contacts a host.
import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '../src/renderer/styles.css';
import fixture from '../src/renderer/components/engine/recommendations.fixture.json';

const GB = 1e9;
const pic = (o: Record<string, unknown>) => ({ owner: 'Tongyi-MAI', license: 'Apache-2.0', capabilities: ['create'], placement: 'gpu', headroomBytes: 0.5 * GB, ...o });
const zImage = pic({ modelId: 'z-image-turbo', name: 'Z-Image Turbo', repo: 'leejet/Z-Image-Turbo-GGUF', companionSet: 'z-image', quant: 'Q4_K', downloadLabel: 'Q4_K', files: ['z_image_turbo-Q4_K.gguf'], weightsBytes: 3.86 * GB, companionBytes: 2.83 * GB, downloadBytes: 6.70 * GB, memoryBytes: 6.0 * GB, offloadToCpu: true, fit: 'tight', time: { seconds: 31, basis: 'measuredHere', samples: 4 } });
const klein = pic({ modelId: 'flux2-klein-4b', name: 'FLUX.2 klein 4B', owner: 'Black Forest Labs', repo: 'leejet/FLUX.2-klein-4B-GGUF', capabilities: ['create', 'edit'], companionSet: 'flux2-klein-4b', quant: 'Q4_0', downloadLabel: 'Q4_0', files: ['flux-2-klein-4b-Q4_0.gguf'], weightsBytes: 2.46 * GB, companionBytes: 2.83 * GB, downloadBytes: 5.29 * GB, memoryBytes: 4.6 * GB, offloadToCpu: true, fit: 'fits' });
const recs = {
  ...(fixture as any).rtx4060,
  // `#update` shows a list an update check brought.
  ...(location.hash === '#update' ? { feedVersion: '2026-12-01.2', feedSource: 'update' } : {}),
  imageTasks: [
    { task: 'imageCreate', label: 'Create pictures', capability: 'create', pick: zImage, options: [zImage, klein] },
    { task: 'imageEdit', label: 'Edit photos', capability: 'edit', pick: klein, options: [klein] },
  ],
};
const catalog = [
  { id: 'unsloth/Qwen3-4B-GGUF', name: 'Qwen3 4B', owner: 'Qwen', parameterSize: '4B', tags: ['chat', 'reasoning'], quants: [{ label: 'Q4_K_M', sizeBytes: 2.5 * GB }], curated: true },
  { id: 'bartowski/google_gemma-3-12b-it-GGUF', name: 'Gemma 3 12B', owner: 'Google', parameterSize: '12B', tags: ['chat', 'vision'], quants: [{ label: 'Q4_K_M', sizeBytes: 7.3 * GB }], curated: true },
  { id: 'bartowski/Qwen2.5-Coder-7B-Instruct-GGUF', name: 'Qwen2.5 Coder 7B', owner: 'Qwen', parameterSize: '7B', tags: ['code', 'tools'], quants: [{ label: 'Q4_K_M', sizeBytes: 4.7 * GB }], curated: true },
];
const hf = (id: string, baseModel: string, downloads: number, sizeGb: number) => ({ id, name: id.split('/')[1].replace(/-gguf$/i, ''), owner: id.split('/')[0], tags: ['chat'], quants: [{ label: 'Q4_K_M', file: 'model-Q4_K_M.gguf', sizeBytes: sizeGb * GB }], downloads, pipelineTag: 'text-to-image', baseModel });
const found = [
  hf('leejet/FLUX.2-klein-4B-GGUF', 'black-forest-labs/FLUX.2-klein-4B', 220320, 2.46),
  hf('unsloth/FLUX.2-klein-9B-GGUF', 'black-forest-labs/FLUX.2-klein-9B', 490506, 5.6),
  hf('city96/FLUX.1-dev-gguf', 'black-forest-labs/FLUX.1-dev', 254498, 6.8),
  hf('acme/FLUX.1-dev-remix-GGUF', 'acme/FLUX.1-dev-remix', 64738, 6.8),
  hf('someone/flux-test-GGUF', 'someone/flux-test', 512, 6.8),
];
const known: Record<string, (...a: unknown[]) => unknown> = {
  machineRecommendations: async () => recs,
  engineCatalog: async (query?: unknown) => (query ? found : catalog),
  engineDownloads: async () => [],
  engineModels: async () => [],
  voiceStatus: async () => ({ installed: false, installing: false, progress: 0, running: false, supported: true, engine: 'whisper', apple: { supported: false, installed: false, installing: false }, whisper: { installed: false, installing: false, progress: 0 } }),
};
(window as any).nekko = new Proxy(known, { get: (t, k: string) => t[k] ?? (k.startsWith('on') ? () => () => {} : async () => null) });

void (async () => {
  const { ModelsHome } = await import('../src/renderer/components/engine/ModelsHome');
  createRoot(document.getElementById('root')!).render(
    <main style={{ minHeight: '100vh', background: 'var(--paper)', color: 'var(--ink)', padding: 24 }}>
      <ModelsHome providerId="nekko-engine" models={[]} canLoad={false} resident={[]} settings={{ autoload: [] } as any} running={false} onChanged={() => {}} onOpenModel={() => {}} />
    </main>,
  );
})();
