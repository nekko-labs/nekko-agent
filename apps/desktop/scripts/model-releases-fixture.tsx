// A repo that publishes three releases of one model in the same quantizations
// (nokeepai/Inkling-2-Mini-Unbound-GGUF, sizes as published). Synthetic: no
// host, no network. `model-releases-before-fixture.tsx` is the same repo as the
// catalog described it before builds carried their release.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ModelDetail } from '../src/renderer/components/engine/ModelDetail';
import '../src/renderer/styles.css';

const before = (globalThis as any).RELEASES_BEFORE === true;
const id = 'nokeepai/Inkling-2-Mini-Unbound-GGUF';
const files: [string | undefined, string, number][] = [
  ['v2.1', 'Q4_K_M', 17782517280], ['v2.1', 'Q8_0', 27820099264],
  ['v2', 'Q4_K_M', 17782517280], ['v2', 'Q8_0', 27820099264],
  [undefined, 'Q4_K_M', 17563029024], [undefined, 'Q8_0', 27820099264], [undefined, 'BF16', 52226509504],
];
const notes: Record<string, string> = { Q4_K_M: 'The usual choice: best balance of size and quality.', Q8_0: 'Effectively full quality. Large.' };
const quants = files.map(([v, q, sizeBytes]) => ({
  label: v && !before ? `${v} ${q}` : q,
  file: `Inkling-2-Mini-Unbound${v ? `-${v}` : ''}-${q}.gguf`,
  sizeBytes,
  note: notes[q],
  ...(v && !before ? { variant: v, quant: q } : {}),
}));
// The old catalog listed builds by quantization rank alone.
if (before) quants.sort((a, b) => ['Q4_K_M', 'Q8_0', 'BF16'].indexOf(a.label) - ['Q4_K_M', 'Q8_0', 'BF16'].indexOf(b.label));
const model = { id, name: 'Inkling 2 Mini Unbound', owner: 'nokeepai', parameterSize: '24B', tags: ['chat', 'vision'], quants };

let jobs: any[] = [];
const listeners = new Set<(jobs: any[]) => void>();
const bridge = {
  engineDownloads: async () => jobs,
  onDownloadsUpdated: (fn: (jobs: any[]) => void) => { listeners.add(fn); return () => listeners.delete(fn); },
  engineCatalogDetail: async () => model,
  engineDownloadModel: async (modelId: string, quant: string) => {
    const key = `model:${modelId}:${quant}`;
    jobs = [{ id: key, kind: 'model', label: key, target: modelId, group: key, state: 'downloading', receivedBytes: 556401985, totalBytes: 27820099264, startedAt: Date.now() }];
    listeners.forEach((f) => f(jobs));
    return { ok: true, message: 'Download queued.' };
  },
  engineStatus: async () => ({}),
};
Object.assign(window, { nekko: bridge });
const memory = { kind: 'unified', budgetBytes: 96e9 } as any;
const noop = () => {};
createRoot(document.getElementById('root')!).render(
  <main className="bg-paper min-h-screen p-5 text-ink"><div className="mx-auto max-w-4xl">
    <ModelDetail embedded modelId={id} installed={[]} memory={memory} onBack={noop} onQueued={noop} />
  </div></main>,
);
