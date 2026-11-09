// A Photo chat after a video model made a clip (real MessageBubble). The
// clip is a still drawn here, not a generated one. Never contacts a host.
import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '../src/renderer/styles.css';

const GB = 1e9;
const zImage = { id: 'image/leejet_Z-Image-Turbo-GGUF/z_image_turbo-Q4_K', name: 'z image turbo', path: '/models/image/leejet_Z-Image-Turbo-GGUF/z_image_turbo-Q4_K.gguf', sizeBytes: 3.86 * GB, addedAt: 0, modality: 'image' };
const known: Record<string, (...a: unknown[]) => unknown> = {
  engineStatus: async () => ({ install: { available: [] }, diffusionInstall: { binPath: '/sd-server', available: [] }, running: true, resident: [], log: [], port: 11500, settings: {} }),
  engineModels: async () => [zImage],
  engineDownloads: async () => [],
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
  const message = { id: 'a', role: 'assistant', content: '', createdAt: 1, images: [src], generated: { modelId: 'image/QuantStack_Wan2.2-TI2V-5B-GGUF/Wan2.2-TI2V-5B-Q8_0', width: 832, height: 480, steps: 20, cfgScale: 6, seed: 1234, ms: 96400, video: { frames: 33, fps: 16 } } } as any;
  const session = { id: 's', title: 'Photo', chatType: 'image', messages: [], createdAt: 1, updatedAt: 1, imageParams: { modelId: zImage.id } } as any;
  createRoot(document.getElementById('root')!).render(
    <main style={{ minHeight: '100vh', background: 'var(--paper)', color: 'var(--ink)', padding: '32px 24px' }}>
      <div className="mx-auto flex max-w-2xl flex-col gap-4">
        <div className="msg-user self-end rounded-2xl px-4 py-2 text-sm" style={{ background: 'var(--surface-2)' }}>Waves rolling into a quiet harbour at dusk</div>
        <MessageBubble message={message} chronological onEditImage={() => {}} />
      </div>
    </main>,
  );
})();
