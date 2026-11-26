import { describe, expect, it } from 'vitest';
import type { CatalogModel } from '@nekko-agent/shared';
import { groupModelFamilies, gpuGuidance, modelFamilyName, smallestVariant, sortLibraryModels, sortModelFamilies, type LibraryModel } from './modelFamilies.js';

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

describe('installed model sorting', () => {
  it('sorts variants by newest added timestamp, then name, by default', () => {
    const models = [
      local('old', { name: 'Zeta', addedAt: 10 }),
      local('new', { name: 'Beta', addedAt: 20 }),
      local('same', { name: 'Alpha', addedAt: 20 }),
    ];
    expect(sortLibraryModels(models).map(m => m.id)).toEqual(['same', 'new', 'old']);
  });

  it('sorts variants by name or size, breaks ties by name and id, and keeps the source order intact', () => {
    const models = [
      local('c', { name: 'Beta', sizeBytes: 20, addedAt: 1 }),
      local('b', { name: 'Alpha', sizeBytes: 20, addedAt: 1 }),
      local('a', { name: 'Alpha', sizeBytes: 20, addedAt: 1 }),
      local('d', { name: 'Aardvark', sizeBytes: 5, addedAt: 2 }),
    ];
    expect(sortLibraryModels(models, 'name').map(m => m.id)).toEqual(['d', 'a', 'b', 'c']);
    expect(sortLibraryModels(models, 'size').map(m => m.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(sortLibraryModels(models, 'recent').map(m => m.id)).toEqual(['d', 'a', 'b', 'c']);
    expect(models.map(m => m.id)).toEqual(['c', 'b', 'a', 'd']);
  });

  it('sorts families by their newest variant or total installed size', () => {
    const families = [
      { name: 'Alpha', local: [local('a', { addedAt: 10, sizeBytes: 50 })], catalog: [] },
      { name: 'Beta', local: [local('b', { addedAt: 20, sizeBytes: 10 }), local('b2', { addedAt: 1, sizeBytes: 90 })], catalog: [] },
    ];
    expect(sortModelFamilies(families).map(f => f.name)).toEqual(['Beta', 'Alpha']);
    expect(sortModelFamilies(families, 'name').map(f => f.name)).toEqual(['Alpha', 'Beta']);
    expect(sortModelFamilies(families, 'size').map(f => f.name)).toEqual(['Beta', 'Alpha']);
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

describe('a model the engine in use will not load', () => {
  const blocked = { level: 'blocked' as const, reason: 'Needs a modified llama.cpp.' };
  it('says so instead of a GPU fit', () => {
    expect(gpuGuidance(6e9, { kind: 'vram', budgetBytes: 31.8e9 }, local('m', { loadCheck: blocked }))).toBe("Can't run here");
    // Even if a stale fit rode along.
    expect(gpuGuidance(6e9, undefined, local('m', { gpuFit: 'full', loadCheck: blocked }))).toBe("Can't run here");
  });
  it('keeps the fit under a warning, since the engine will try', () => {
    expect(gpuGuidance(6e9, undefined, local('m', { gpuFit: 'full', loadCheck: { level: 'warning', reason: 'x' } }))).toBe('Fits on GPU');
  });
  it('speaks for a family by the files that can run', () => {
    const files = [local('Bonsai-PTQ1_0.gguf', { sizeBytes: 5, loadCheck: blocked }), local('Bonsai-Q2_0.gguf', { sizeBytes: 7, gpuFit: 'full' })];
    expect(smallestVariant(files)?.name).toBe('Bonsai-Q2_0.gguf');
    expect(smallestVariant(files.slice(0, 1))?.name).toBe('Bonsai-PTQ1_0.gguf');
    expect(smallestVariant([])).toBeUndefined();
  });
  it('names the fix when only the engine’s age is in the way, and lets that file speak for the family', () => {
    const tooOld = { level: 'blocked' as const, cause: 'engineAge' as const, reason: 'Needs llama.cpp b11556 or newer.' };
    expect(gpuGuidance(7e9, undefined, local('m', { loadCheck: tooOld }))).toBe('Needs a newer engine');
    const files = [local('Bonsai-PTQ1_0.gguf', { sizeBytes: 5, loadCheck: { ...blocked, cause: 'weightFormat' } }), local('Bonsai-Q2_0.gguf', { sizeBytes: 7, loadCheck: tooOld })];
    expect(smallestVariant(files)?.name).toBe('Bonsai-Q2_0.gguf');
  });
});
