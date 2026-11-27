import type { LocalModel } from '@nekko-agent/shared';
import { describe, expect, it } from 'vitest';
import { dflash2DraftName, draftModelCandidates } from './draftModels.js';

const gguf: LocalModel = {
  id: 'local-target', name: 'Qwen3.8-27B', path: '/models/renamed.gguf',
  architecture: 'qwen35', modality: 'chat', layers: 64, addedAt: 0, sizeBytes: 19_403_684_480, readable: true,
};
const ggufHead: LocalModel = {
  ...gguf, format: 'gguf', id: 'local-head', name: 'Qwen3.8-27B-DFlash2', path: '/models/other-name.gguf',
  architecture: 'dflash', modality: 'draft', layers: 5, sizeBytes: 1_143_006_816,
};
const mlx: LocalModel = {
  ...gguf, id: 'mlx-target', format: 'mlx', name: 'mlx-community_Qwen3.8-27B-4bit',
  path: '/models/vision/mlx-community_Qwen3.8-27B-4bit', architecture: 'qwen3_5', modality: 'vision', mlxRunnable: true,
};
const mlxHead: LocalModel = {
  ...ggufHead, id: 'mlx-head', format: 'mlx', name: 'incoai_Qwen3.8-27B-DFlash2',
  path: '/models/draft/incoai_Qwen3.8-27B-DFlash2', architecture: 'qwen3', mlxRunnable: true,
};

const pick = (target: LocalModel, ...models: LocalModel[]) => draftModelCandidates(target, models).map((m) => m.id);

describe('local draft picker', () => {
  it('matches the real GGUF header names independently of ids, filenames or an explicit GGUF format', () => {
    expect(pick(gguf, gguf, ggufHead, mlxHead)).toEqual(['local-head']);
    expect(dflash2DraftName(ggufHead)).toBe('Qwen3.8-27B-DFlash2');
    expect(pick({ ...gguf, name: 'Qwen3.8 27B' }, ggufHead)).toEqual(['local-head']);
    expect(pick(gguf, { ...ggufHead, format: undefined })).toEqual(['local-head']);
  });

  it.each(['Qwen3.8-27B GSQ-RCO', 'Qwen3.8-27B-abliterated', 'Huihui Qwen3.8-27B', 'Qwen3.5-27B', 'Qwen3.8-32B'])(
    'does not offer the stock head for GGUF %s even with a stock-looking id', (name) => {
      expect(pick({ ...gguf, name, id: 'Qwen3.8-27B-Q4_K_M' }, ggufHead)).toEqual([]);
    },
  );

  it('requires readable GGUF metadata and excludes different heads and unrelated architectures', () => {
    expect(pick({ ...gguf, readable: false }, ggufHead)).toEqual([]);
    expect(pick({ ...gguf, layers: 32 }, ggufHead)).toEqual([]);
    expect(pick(gguf, ...[
      { readable: false }, { name: 'Qwen3.8-27B-DFlash' }, { name: 'Qwen3.8-27B-DFlash2-finetune' }, { name: 'Qwen3.5-27B-DFlash2' },
    ].map((fields) => ({ ...ggufHead, ...fields })))).toEqual([]);
  });

  it('pairs the MLX qwen3 draft classified by its config, not by a dflash architecture string', () => {
    expect(pick(mlx, ggufHead, mlxHead)).toEqual(['mlx-head']);
    expect(pick({ ...mlx, path: '/models/lmstudio-community/Qwen3.8-27B-MLX-8bit' }, mlxHead)).toEqual(['mlx-head']);
    expect(dflash2DraftName(mlxHead)).toBe('Qwen3.8-27B-DFlash2');
    expect(pick({ ...mlx, path: '/models/Qwen3.8-27B-bf16' }, { ...mlxHead, path: '/models/Qwen3.8-27B-DFlash2/' })).toEqual(['mlx-head']);
    expect(pick(
      { ...mlx, name: 'target-revision', path: '/cache/models--mlx-community--Qwen3.8-27B-8bit/snapshots/target-revision' },
      { ...mlxHead, name: 'draft-revision', path: '/cache/models--incoai--Qwen3.8-27B-DFlash2/snapshots/draft-revision' },
    )).toEqual(['mlx-head']);
  });

  it('excludes renamed/unsupported MLX targets and MLX heads that do not match', () => {
    for (const fields of [
      { path: '/models/Qwen3.8-27B-finetune-4bit' }, { path: '/cache/models--someone-else--Qwen3.8-27B-4bit/snapshots/rev' },
      { architecture: 'qwen3_5_text' }, { modality: 'chat' as const }, { mlxRunnable: false },
    ]) expect(pick({ ...mlx, ...fields }, mlxHead)).toEqual([]);
    expect(pick(mlx, { ...mlxHead, path: '/models/Qwen3.8-27B-DFlash2-Finetune' })).toEqual([]);
    expect(pick(mlx, { ...mlxHead, modality: 'chat' })).toEqual([]);
    expect(pick(mlx, { ...mlxHead, mlxRunnable: false })).toEqual([]);
  });

  it('keeps ordinary drafts by format, architecture, modality, and at most a quarter of target size', () => {
    const tune = { ...gguf, name: 'Qwen3.8-27B fine-tune', sizeBytes: 20_000 };
    const small = { ...tune, id: 'small', sizeBytes: 5_000 };
    expect(pick(tune, tune, small, ggufHead, { ...small, id: 'legacy', modality: undefined },
      { ...small, sizeBytes: 5_001 }, { ...small, architecture: 'qwen3' }, { ...small, modality: 'vision' },
      { ...small, format: 'mlx' }, { ...small, id: 'draft', modality: 'draft' },
    )).toEqual(['small', 'legacy', 'draft']);
    const smallMlx = { ...mlx, id: 'small-mlx', sizeBytes: 5_000, modality: 'chat' as const };
    expect(pick(mlx, { ...smallMlx, format: 'gguf' }, smallMlx, mlxHead)).toEqual(['small-mlx', 'mlx-head']);
  });
});
