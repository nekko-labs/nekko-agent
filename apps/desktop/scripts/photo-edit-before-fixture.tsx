// Before edit support: a Photo chat after a picture was made (real MessageBubble),
// button) and the offer shown when a photo is attached but the chat's model,
// Z-Image Turbo, cannot edit (real EditModelOffer). Stub bridge: an RTX 5090
// whose only picture model is Z-Image. Never contacts a host.
import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '../src/renderer/styles.css';

const GB = 1e9;
const edit = { modelId: 'qwen-image-edit-2511', name: 'Qwen Image Edit 2511', owner: 'Qwen', repo: 'unsloth/Qwen-Image-Edit-2511-GGUF', license: 'Apache-2.0', capabilities: ['edit'], companionSet: 'qwen-image-edit', quant: 'Q4_K_M', downloadLabel: 'Q4_K_M', files: ['qwen-image-edit-2511-Q4_K_M.gguf'], weightsBytes: 12.84 * GB, companionBytes: 5.79 * GB, downloadBytes: 18.63 * GB, memoryBytes: 20.8 * GB, headroomBytes: 12.5 * GB, placement: 'gpu', offloadToCpu: false, fit: 'fits' };
const klein = { ...edit, modelId: 'flux2-klein-4b', name: 'FLUX.2 klein 4B', owner: 'Black Forest Labs', repo: 'leejet/FLUX.2-klein-4B-GGUF', capabilities: ['create', 'edit'], companionSet: 'flux2-klein-4b', quant: 'Q8_0', downloadLabel: 'Q8_0', files: ['flux-2-klein-4b-Q8_0.gguf'], weightsBytes: 4.3 * GB, companionBytes: 2.83 * GB, downloadBytes: 7.13 * GB, memoryBytes: 9.3 * GB };
const recs = { feedVersion: '2026-11-08.1', hardware: { device: 'NVIDIA GeForce RTX 5090', classId: 'nvidia-rtx-5090', bandwidthGBps: 1792, backend: 'cuda', memoryBytes: 32 * 2 ** 30 }, budget: { bytes: 31 * 2 ** 30, placement: 'gpu' }, tasks: [], nudges: [],
  imageTasks: [{ task: 'imageEdit', label: 'Edit photos', capability: 'edit', pick: edit, options: [edit, klein] }] };
const zImage = { id: 'image/leejet_Z-Image-Turbo-GGUF/z_image_turbo-Q4_K', name: 'z image turbo', path: '/models/image/leejet_Z-Image-Turbo-GGUF/z_image_turbo-Q4_K.gguf', sizeBytes: 3.86 * GB, addedAt: 0, modality: 'image' };
const known: Record<string, (...a: unknown[]) => unknown> = {
  engineStatus: async () => ({ install: { available: [] }, diffusionInstall: { binPath: '/sd-server', available: [] }, running: true, resident: [], log: [], port: 11500, settings: {} }),
  engineModels: async () => [zImage],
  engineDownloads: async () => [],
  machineRecommendations: async () => recs,
  engineImageCompanions: async () => ({ setId: 'z-image', label: 'Z-Image', files: [], ready: true, missingBytes: 0, defaults: { steps: 8, cfgScale: 1 }, capabilities: ['create'] }),
};
(window as any).nekko = new Proxy(known, { get: (t, k: string) => t[k] ?? (k.startsWith('on') ? () => () => {} : async () => null) });

/** A made-up picture: a dusk gradient with a sun, drawn here, not generated. */
function picture(): string {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d')!;
  const sky = g.createLinearGradient(0, 0, 0, 512);
  sky.addColorStop(0, '#2b3a67'); sky.addColorStop(0.6, '#e98a6c'); sky.addColorStop(1, '#3b2f3f');
  g.fillStyle = sky; g.fillRect(0, 0, 512, 512);
  g.fillStyle = '#ffd59e'; g.beginPath(); g.arc(256, 330, 70, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#26303f'; g.fillRect(0, 380, 512, 132);
  return c.toDataURL('image/png');
}

void (async () => {
  const { MessageBubble } = await import('../src/renderer/components/agent-console/MessageBubble');
  const src = picture();
  const message = { id: 'a', role: 'assistant', content: '', createdAt: 1, images: [src], generated: { modelId: zImage.id, width: 1024, height: 1024, steps: 8, cfgScale: 1, seed: 1234, ms: 14200 } } as any;
  const session = { id: 's', title: 'Photo', chatType: 'image', messages: [], createdAt: 1, updatedAt: 1, imageParams: { modelId: zImage.id } } as any;
  createRoot(document.getElementById('root')!).render(
    <main style={{ minHeight: '100vh', background: 'var(--paper)', color: 'var(--ink)', padding: '32px 24px' }}>
      <div className="mx-auto flex max-w-2xl flex-col gap-4">
        <div className="msg-user self-end rounded-2xl px-4 py-2 text-sm" style={{ background: 'var(--surface-2)' }}>A quiet harbour at dusk</div>
        <MessageBubble message={message} chronological onEditImage={() => {}} />
      </div>
    </main>,
  );
})();
