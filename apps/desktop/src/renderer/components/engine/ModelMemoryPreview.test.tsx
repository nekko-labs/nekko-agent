import { describe, expect, it } from 'vitest';
import { modelMemoryPreview } from './ModelMemoryPreview.js';
import type { LibraryModel } from './modelFamilies.js';

const GB = 1024 ** 3;
const model: LibraryModel = { id: 'm', name: 'Model', path: '/model', sizeBytes: 10 * GB, addedAt: 0, loaded: false, gpuFit: 'full' };
const shared = { kind: 'unified', budgetBytes: 32 * GB } as const;

describe('installed model memory preview', () => {
  it('estimates a known single-pool load against total capacity', () => {
    expect(modelMemoryPreview(model, shared)).toEqual({
      bytes: 12 * GB, scale: 32 * GB, estimated: true, text: '~12.0 GB estimated load · 32.0 GB shared memory',
    });
  });

  it('does not report disk size as RAM for MLX, diffusion or split GGUF', () => {
    const vram = { kind: 'vram', budgetBytes: 16 * GB } as const;
    for (const variant of [{ ...model, format: 'mlx' }, { ...model, modality: 'image' }, { ...model, gpuFit: 'partial' } ] as LibraryModel[]) {
      expect(modelMemoryPreview(variant, vram)).toMatchObject({ bytes: 10 * GB, scale: 16 * GB, estimated: false, text: '10.0 GB weights on disk · 16.0 GB VRAM capacity' });
    }
  });

  it('omits the scale if memory capacity is unknown and does not invent a size', () => {
    expect(modelMemoryPreview(model)).toMatchObject({ scale: null, text: '10.0 GB weights on disk' });
    expect(modelMemoryPreview({ ...model, sizeBytes: 0 }, shared)).toMatchObject({ bytes: null, scale: null, text: 'Load size unknown' });
  });
});
