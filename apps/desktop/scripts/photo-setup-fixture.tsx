// The Photo chat's empty state with the real PhotoModelSetup and image controls,
// against a stub bridge (an RTX 4060 with no picture model yet). Never contacts a host.
import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter-tight';
import '../src/renderer/styles.css';

const GB = 1e9;
const option = (o: Record<string, unknown>) => ({
  owner: 'Tongyi-MAI', license: 'Apache-2.0', capabilities: ['create'], placement: 'gpu', offloadToCpu: false, headroomBytes: 0, ...o,
});
// The RTX 4060 8 GB picks from crates/nekko-machine/tests/recommend.rs, with the feed's real sizes.
const recs = {
  feedVersion: '2026-11-08.1',
  hardware: { device: 'NVIDIA GeForce RTX 4060', classId: 'nvidia-rtx-4060', bandwidthGBps: 272, backend: 'vulkan', memoryBytes: 8 * 2 ** 30 },
  budget: { bytes: 7 * 2 ** 30, placement: 'gpu' },
  tasks: [],
  nudges: [],
  imageTasks: [{
    task: 'imageCreate', label: 'Create pictures', capability: 'create',
    pick: null as unknown,
    options: [
      option({ modelId: 'qwen-image', name: 'Qwen Image', owner: 'Qwen', repo: 'QuantStack/Qwen-Image-GGUF', companionSet: 'qwen-image', quant: 'Q4_K_M', downloadLabel: 'Q4_K_M', files: ['Qwen_Image-Q4_K_M.gguf'], weightsBytes: 13.07 * GB, companionBytes: 4.94 * GB, downloadBytes: 18.0 * GB, memoryBytes: 15.2 * GB, fit: 'tooBig' }),
      option({ modelId: 'z-image-turbo', name: 'Z-Image Turbo', repo: 'leejet/Z-Image-Turbo-GGUF', companionSet: 'z-image', quant: 'Q4_K', downloadLabel: 'Q4_K', files: ['z_image_turbo-Q4_K.gguf'], weightsBytes: 3.86 * GB, companionBytes: 2.83 * GB, downloadBytes: 6.70 * GB, memoryBytes: 6.0 * GB, offloadToCpu: true, fit: 'tight' }),
      option({ modelId: 'flux2-klein-4b', name: 'FLUX.2 klein 4B', owner: 'Black Forest Labs', repo: 'leejet/FLUX.2-klein-4B-GGUF', capabilities: ['create', 'edit'], companionSet: 'flux2-klein-4b', quant: 'Q4_0', downloadLabel: 'Q4_0', files: ['flux-2-klein-4b-Q4_0.gguf'], weightsBytes: 2.46 * GB, companionBytes: 2.83 * GB, downloadBytes: 5.29 * GB, memoryBytes: 4.6 * GB, offloadToCpu: true, fit: 'fits' }),
    ],
  }],
};
recs.imageTasks[0].pick = recs.imageTasks[0].options[1];

const listeners = new Set<(jobs: unknown[]) => void>();
const state = { jobs: [] as unknown[] };
const now = Date.now();
const stages: Record<string, unknown[]> = {
  choose: [],
  model: [{ id: 'm', kind: 'model', label: 'Z-Image Turbo · Q4_K', target: 'z', group: 'g', groupLabel: 'Z-Image Turbo · Q4_K', dest: '/models/image/leejet_Z-Image-Turbo-GGUF/z_image_turbo-Q4_K.gguf', file: 'z_image_turbo-Q4_K.gguf', state: 'downloading', receivedBytes: 1.6 * GB, totalBytes: 3.86 * GB, bytesPerSecond: 40e6, startedAt: now - 40e3 }],
};
const known: Record<string, (...a: unknown[]) => unknown> = {
  engineStatus: async () => ({ install: { available: [] }, diffusionInstall: { available: [], recommended: { id: 'sd-vulkan' } }, running: false, resident: [], log: [], port: 11500, settings: {} }),
  engineModels: async () => [],
  engineDownloads: async () => state.jobs,
  machineRecommendations: async () => recs,
  engineImageCompanions: async () => null,
  onDownloadsUpdated: (cb: unknown) => { listeners.add(cb as (j: unknown[]) => void); return () => listeners.delete(cb as (j: unknown[]) => void); },
};
(window as any).nekko = new Proxy(known, {
  get: (t, k: string) => t[k] ?? (k.startsWith('on') ? () => () => {} : async () => null),
});
(window as any).photoFixture = { stage: (name: string) => { state.jobs = stages[name]; listeners.forEach((l) => l(state.jobs)); } };

const session = { id: 's1', title: 'Photo', chatType: 'image', messages: [], createdAt: now, updatedAt: now, imageParams: {} } as any;

void (async () => {
  const { PhotoModelSetup } = await import('../src/renderer/components/agent-console/PhotoModelSetup');
  const { ImageModeControls } = await import('../src/renderer/components/agent-console/ImageModeControls');
  function Welcome() {
    const [shown, setShown] = React.useState(false);
    return (
      <main style={{ minHeight: '100vh', background: 'var(--paper)', color: 'var(--ink)', padding: '48px 24px' }}>
        <div className="mx-auto flex max-w-2xl flex-col items-center gap-3 text-center">
          <div className="grid h-12 w-12 place-items-center rounded-2xl" style={{ background: 'var(--accent-soft)' }} />
          <h2 className="text-base font-semibold">What should Nekko Agent draw?</h2>
          <PhotoModelSetup session={session} onReady={() => {}} onShown={setShown} />
          {!shown && <div className="mt-4 flex w-full max-w-xl flex-col gap-2 text-left">
            <span className="px-2 text-xs font-medium text-ink-soft">Choose a model</span>
            <div className="flex items-center gap-1"><ImageModeControls session={session} onChange={() => {}} busy={false} /></div>
          </div>}
        </div>
      </main>
    );
  }
  createRoot(document.getElementById('root')!).render(<Welcome />);
})();
