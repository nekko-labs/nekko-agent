import { describe, expect, it } from 'vitest';
import type { CatalogModel } from '@nekko-agent/shared';
import { groupModelFamilies, gpuGuidance, modelFamilyName, type LibraryModel } from './modelFamilies.js';

const local = (name: string, extra: Partial<LibraryModel> = {}): LibraryModel => ({ id: name, name, path: name, sizeBytes: 100, addedAt: 0, loaded: false, ...extra });
const catalog = (name: string, extra: Partial<CatalogModel> = {}): CatalogModel => ({ id: `publisher/${name}`, name, owner: 'publisher', tags: [], quants: [], ...extra });

describe('model families', () => {
  it('combines quantizations and publishers with local copies', () => {
    const groups = groupModelFamilies([local('Qwen3-8B-Q4_K_M.gguf', { folderProvider: 'lmstudio' }), local('Qwen3-8B-Q8_0.gguf')], [catalog('Qwen3-8B-GGUF'), catalog('Qwen3-8B-4bit', { id: 'mlx/Qwen3-8B-4bit' })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].local).toHaveLength(2);
    expect(groups[0].catalog).toHaveLength(2);
  });
  it('keeps sizes and fine tunes distinct', () => {
    expect(groupModelFamilies([], [catalog('Qwen3-8B'), catalog('Qwen3-32B'), catalog('Qwen3-8B-Coder')])).toHaveLength(3);
  });
  it('uses explicit base model metadata to match conversion repos', () => {
    expect(groupModelFamilies([local('weights', { sourceRepo: 'publisher/conversion' })], [catalog('conversion', { id: 'publisher/conversion', baseModel: 'Qwen/Qwen3-8B' })])[0].local).toHaveLength(1);
  });
  it('names a borrowed LM Studio model by its repo and drops a trailing gguf', () => {
    expect(modelFamilyName('prism-ml/Ternary-Bonsai-2-27B-gguf')).toBe('Ternary-Bonsai-2-27B');
    expect(modelFamilyName('empero-ai/Qwen3.8-2B-Distill-GGUF')).toBe('Qwen3.8-2B-Distill');
    const groups = groupModelFamilies([
      local('Ternary-Bonsai-2-27B-PTQ1_0', { sourceRepo: 'prism-ml/Ternary-Bonsai-2-27B-gguf', folderProvider: 'lmstudio' }),
      local('Ternary-Bonsai-2-27B-Q4_K_M', { sourceRepo: 'someone/Ternary-Bonsai-2-27B-GGUF', folderProvider: 'lmstudio' }),
      local('Qwen3.8-2B-BF16', { sourceRepo: 'empero-ai/Qwen3.8-2B-Distill-GGUF', folderProvider: 'lmstudio' }),
      local('Qwen3.8-4B-BF16', { sourceRepo: 'empero-ai/Qwen3.8-4B-Distill-GGUF', folderProvider: 'lmstudio' }),
    ], []);
    expect(groups.map(g => [g.name, g.local.length]).sort()).toEqual([['Qwen3.8-2B-Distill', 1], ['Qwen3.8-4B-Distill', 1], ['Ternary-Bonsai-2-27B', 2]]);
  });
  it('normalizes filename suffixes without stripping parameter counts', () => {
    expect(modelFamilyName('owner/Qwen3-8B-Q4_K_M.gguf')).toBe('Qwen3-8B');
  });
});

describe('GPU guidance', () => {
  it('does not call system RAM a GPU', () => expect(gpuGuidance(10, { kind: 'ram', budgetBytes: 100 })).toBe('CPU only'));
  it('keeps missing hardware unknown', () => expect(gpuGuidance(10)).toBe('GPU fit unknown'));
  it('shows measured reduced context and partial offload honestly', () => {
    expect(gpuGuidance(10, undefined, local('m', { gpuFit: 'full', maxContext: 32000, preset: { contextTokens: 4096 } }))).toBe('Fits on GPU, but limited context size');
    expect(gpuGuidance(10, undefined, local('m', { gpuFit: 'partial' }))).toBe('Not enough free GPU memory');
  });
  it('says whether a partial fit is only a busy GPU, from the idle verdict', () => {
    const vram = { kind: 'vram' as const, budgetBytes: 31.8e9 };
    expect(gpuGuidance(15.7e9, vram, local('m', { gpuFit: 'partial', gpuFitIdle: 'full' }))).toBe('Fits when the GPU is free');
    expect(gpuGuidance(5.5e9, vram, local('m', { gpuFit: 'partial', gpuFitIdle: 'partial' }))).toBe('Part on CPU at this context size');
    expect(gpuGuidance(30e9, vram, local('m', { gpuFit: 'partial', gpuFitIdle: 'wont' }))).toBe('Part on CPU at this context size');
    expect(gpuGuidance(15.7e9, vram, local('m', { gpuFit: 'partial' }))).toBe('Not enough free GPU memory');
    expect(gpuGuidance(15.7e9, vram, local('m', { gpuFit: 'partial', layers: 64, preset: { gpuLayers: 40 } }))).toBe('Part on CPU by its settings');
    expect(gpuGuidance(15.7e9, vram, local('m', { gpuFit: 'wont' }))).toBe('Too big');
  });
});
