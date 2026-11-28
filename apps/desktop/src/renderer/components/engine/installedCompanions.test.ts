import type { LocalModel } from '@nekko-agent/shared';
import { describe, expect, it } from 'vitest';
import { companionKind, installedCompanionPairs } from './installedCompanions.js';

const repo = 'Publisher/Qwen3.8-27B';
const base = {
  id: 'base', path: '/models/base.gguf', name: 'Qwen3.8-27B', modality: 'chat',
  architecture: 'qwen35', layers: 64, sizeBytes: 10_000, addedAt: 0, readable: true, loraBaseRepo: repo,
} satisfies LocalModel & { loraBaseRepo: string };
const lora = {
  ...base, id: 'adapter', path: '/models/adapter.gguf', name: 'Adapter',
  companion: { kind: 'lora' as const, baseRepo: repo },
};
const draft = { ...base, id: 'head', path: '/models/head.gguf', name: 'Qwen3.8-27B-DFlash2', architecture: 'dflash', modality: 'draft' as const };
const mlx: LocalModel = {
  ...base, id: 'mlx', path: '/models/Qwen3.8-27B-4bit', format: 'mlx', architecture: 'qwen3_5', modality: 'vision', mlxRunnable: true,
};
const mlxDraft: LocalModel = {
  ...draft, id: 'mlx-head', path: '/models/Qwen3.8-27B-DFlash2', format: 'mlx', architecture: 'qwen3', mlxRunnable: true,
};

const pairedIds = (base: LocalModel, ...models: LocalModel[]) => [...installedCompanionPairs([base, ...models]).pairedIds];

describe('installed companions', () => {
  it('uses the backend checkpoint repo, not the same-looking name or distribution repo', () => {
    expect(pairedIds(base, lora)).toEqual(['adapter']);
    const distributionOnly = { ...base, loraBaseRepo: undefined, sourceRepo: repo };
    expect(pairedIds(distributionOnly, lora)).toEqual([]);
    expect(pairedIds({ ...base, loraBaseRepo: 'Other/Qwen3.8-27B' } as typeof base, lora)).toEqual([]);
    expect(pairedIds(base, { ...lora, architecture: 'qwen2' })).toEqual([]);
  });

  it('does not attach unknown, unreadable, sharded, or unsupported LoRA files', () => {
    const orphan = { ...lora, companion: { kind: 'lora' as const } };
    expect(companionKind(orphan)).toBe('lora');
    expect(pairedIds(base, orphan, { ...lora, readable: false }, { ...lora, path: '/models/shard-00001-of-00002.gguf' },
      { ...lora, unknownWeightType: 143 }, { ...lora, format: 'mlx' })).toEqual([]);
  });

  it('uses recognized DFlash2 identities in the same format, not names or size ratios alone', () => {
    const small = { ...base, id: 'small-chat', name: 'Qwen3.8-1B', sizeBytes: 1000, layers: 12 };
    expect(companionKind(small)).toBeUndefined();
    expect(pairedIds(base, draft, mlxDraft, small)).toEqual(['head']);
    expect(pairedIds(mlx, draft, mlxDraft)).toEqual(['mlx-head']);
    expect(pairedIds({ ...base, name: 'Qwen3.8-27B Tuned' }, draft)).toEqual([]);
    expect(pairedIds(base, { ...draft, name: 'Qwen3.8-27B-DFlash2 Tuned' })).toEqual([]);
    expect(pairedIds({ ...mlx, mlxRunnable: false }, mlxDraft)).toEqual([]);
  });
});
