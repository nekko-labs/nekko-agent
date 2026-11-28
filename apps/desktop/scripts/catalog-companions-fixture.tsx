import React from 'react';
import { createRoot } from 'react-dom/client';
import { ModelDetail } from '../src/renderer/components/engine/ModelDetail.js';

const id = 'incoai/Qwen3.8-27B-DFlash2-GGUF';
const base = { repo: 'ggml-org/Qwen3.8-27B-GGUF', quant: 'Q4_K_M', file: 'Qwen3.8-27B-Q4_K_M.gguf', sizeBytes: 16900000000 };
const state = { mode: 'pair', requests: [] as unknown[][] };
Object.assign(window, {
  fixture: state,
  nekko: {
    engineDownloads: async () => [], onDownloadsUpdated: () => () => {}, engineCatalogChecks: async () => ({}),
    engineCatalogDetail: async (repo: string) => ({
      id: repo, name: 'Qwen3.8-27B-DFlash2', owner: 'incoai', tags: ['draft'], dependent: true,
      quants: [{ label: 'Q4_K_M', file: 'Qwen3.8-27B-DFlash2-Q4_K_M.gguf', sizeBytes: 832000000,
        companion: state.mode === 'unresolved' ? { kind: 'lora', reason: 'The exact base checkpoint is unknown.' } : {
          kind: 'draft', baseRepo: 'Qwen/Qwen3.8-27B',
          ...(state.mode === 'installed' ? { installedBase: { id: 'stock', name: 'My stock Qwen' } } : { base }),
        },
      }],
    }),
    engineDownloadModel: async (...args: unknown[]) => { state.requests.push(args); return { ok: false, message: 'Fixture only' }; },
  },
});
const root = createRoot(document.getElementById('root')!);
const render = () => root.render(<main className="bg-paper min-h-screen p-5 text-ink">
  <ModelDetail key={state.mode} embedded modelId={state.mode === 'pair' ? id : `${id}-${state.mode}`} installed={[]}
    memory={{ kind: 'unified', budgetBytes: 64e9 } as any} onBack={() => {}} onQueued={() => {}} />
</main>);
Object.assign(state, { render });
render();
