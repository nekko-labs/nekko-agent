// The Models page (real ModelsHome) against a stub bridge: an RTX 4060 with no
// models yet, the chat recommendations from the shared fixture plus the
// picture picks, and a catalog of the usual chat starters. Never contacts a host.
import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter-tight';
import '../src/renderer/styles.css';
import fixture from '../src/renderer/components/engine/recommendations.fixture.json';

const GB = 1e9;
const pic = (o: Record<string, unknown>) => ({ owner: 'Tongyi-MAI', license: 'Apache-2.0', capabilities: ['create'], placement: 'gpu', headroomBytes: 0.5 * GB, ...o });
const zImage = pic({ modelId: 'z-image-turbo', name: 'Z-Image Turbo', repo: 'leejet/Z-Image-Turbo-GGUF', companionSet: 'z-image', quant: 'Q4_K', downloadLabel: 'Q4_K', files: ['z_image_turbo-Q4_K.gguf'], weightsBytes: 3.86 * GB, companionBytes: 2.83 * GB, downloadBytes: 6.70 * GB, memoryBytes: 6.0 * GB, offloadToCpu: true, fit: 'tight' });
const klein = pic({ modelId: 'flux2-klein-4b', name: 'FLUX.2 klein 4B', owner: 'Black Forest Labs', repo: 'leejet/FLUX.2-klein-4B-GGUF', capabilities: ['create', 'edit'], companionSet: 'flux2-klein-4b', quant: 'Q4_0', downloadLabel: 'Q4_0', files: ['flux-2-klein-4b-Q4_0.gguf'], weightsBytes: 2.46 * GB, companionBytes: 2.83 * GB, downloadBytes: 5.29 * GB, memoryBytes: 4.6 * GB, offloadToCpu: true, fit: 'fits' });
const recs = {
  ...(fixture as any).rtx4060,
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
const known: Record<string, (...a: unknown[]) => unknown> = {
  machineRecommendations: async () => recs,
  engineCatalog: async () => catalog,
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
