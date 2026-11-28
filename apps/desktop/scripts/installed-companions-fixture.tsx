import { createRoot } from 'react-dom/client';
import type { LocalModel } from '@nekko-agent/shared';
import { ModelsHome } from '../src/renderer/components/engine/ModelsHome';
import { useStore } from '../src/renderer/store';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';

type FixtureModel = LocalModel & { loaded: boolean; companion?: { kind: 'lora'; baseRepo?: string }; loraBaseRepo?: string };
const repo = 'Publisher/Qwen3.8-27B';
const model = (id: string, name: string, extra: Partial<FixtureModel> = {}): FixtureModel => ({
  id, name, path: `/fixture/${id}.gguf`, sizeBytes: 2 * 1024 ** 3, addedAt: 0,
  readable: true, loaded: false, modality: 'chat', architecture: 'qwen35', ...extra,
});
const models = [
  model('base', 'Qwen3.8-27B', { layers: 64, loraBaseRepo: repo, preset: { contextTokens: 8192, draftModelId: 'small', speculative: false }, sizeBytes: 16 * 1024 ** 3, addedAt: 1 }),
  model('other', 'Qwen3.8-27B-Tuned', { layers: 64, preset: { contextTokens: 4096, draftModelId: 'small' } }),
  model('draft', 'Qwen3.8-27B-DFlash2', { architecture: 'dflash', modality: 'draft' }),
  model('lora', 'Writing Style Adapter', { companion: { kind: 'lora', baseRepo: repo } }),
  model('unknown', 'Unknown Source LoRA', { companion: { kind: 'lora' } }),
  model('mismatch', 'Wrong Checkpoint LoRA', { companion: { kind: 'lora', baseRepo: 'Other/Qwen3.8-27B' } }),
  model('mlx-lora', 'MLX Style Adapter', { format: 'mlx', mlxRunnable: true, companion: { kind: 'lora', baseRepo: repo } }),
  model('small', 'Qwen3.8-1B', { sizeBytes: 1024 ** 3 }),
];
const loads: unknown[][] = [];
Object.assign(window, { fixture: { loads }, nekko: {
  engineCatalog: async () => [], engineCatalogDetail: async () => null, machineRecommendations: async () => null,
  runtimeAutoFit: async () => ({ request: { contextTokens: 8192, gpuLayerFraction: 0.5 }, plan: { totalLayers: 64 } }),
  runtimeLoad: async (...args: unknown[]) => { loads.push(args); return { ok: true }; },
} });
useStore.setState({ settings: { providers: [] } as NonNullable<ReturnType<typeof useStore.getState>['settings']> });
createRoot(document.getElementById('root')!).render(<main className="mx-auto max-w-5xl p-5">
  <ModelsHome providerId="nekko-engine" mode="installed" models={models} canLoad resident={[]} settings={{ port: 11500, autoStart: false, bind: 'local' }} onChanged={() => {}} />
</main>);
