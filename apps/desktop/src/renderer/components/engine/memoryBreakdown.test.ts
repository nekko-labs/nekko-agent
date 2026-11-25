import { describe, expect, it } from 'vitest';
import type { PlacementPlan } from '@nekko-agent/shared';
import { breakdown, contextDriver, livePools, sumRam, sumVram, weightsLoading } from './memoryBreakdown.js';

const GB = 1024 ** 3;
const MB = 1024 ** 2;

const share = (w = 0, kv = 0, o = 0, pin = 0) => ({ weightsBytes: w, kvCacheBytes: kv, overheadBytes: o, pinnedBytes: pin });

function plan(over: Partial<PlacementPlan> = {}): PlacementPlan {
  return {
    verdict: 'fits',
    unified: false,
    deviceName: 'RTX 4090',
    vram: { totalBytes: 24 * GB, otherBytes: 2 * GB, availBytes: 22 * GB, model: share(8 * GB, 4 * GB, 1 * GB) },
    ram: { totalBytes: 64 * GB, otherBytes: 10 * GB, availBytes: 52 * GB, model: share() },
    disk: { tableBytes: 0, overflowBytes: 0 },
    spareVramBytes: 0,
    ...over,
  };
}

describe('breakdown', () => {
  it('names each part by the setting behind it, with parallel sessions as slices', () => {
    const parts = breakdown(plan(), { contextTokens: 4 * 32768, parallelSlots: 4, kvCacheDtype: 'q8_0' }, 40);
    expect(parts.map((p) => p.aspect)).toEqual(['weights', 'context', 'working']);
    expect(parts[0].driver).toBe('all 40 layers on the GPU, mapped from the file');
    expect(parts[1].driver).toBe('4 sessions × 32k, standard (q8_0)');
    expect(parts[1].slices).toBe(4);
    expect(sumVram(parts)).toBe(13 * GB);
    expect(sumRam(parts)).toBe(0);
  });

  it('splits the expert cache out of the weights and keeps a hybrid split in both pools', () => {
    const p = plan({
      vram: { totalBytes: 12 * GB, otherBytes: 1 * GB, availBytes: 11 * GB, model: share(6 * GB, 2 * GB, 1 * GB) },
      ram: { totalBytes: 64 * GB, otherBytes: 10 * GB, availBytes: 52 * GB, model: share(20 * GB, 0, 512 * MB) },
    });
    const parts = breakdown(p, { gpuLayers: 48, cpuMoeLayers: 48, moeCacheMiB: 1024, mlock: false }, 48);
    const weights = parts.find((x) => x.aspect === 'weights')!;
    const experts = parts.find((x) => x.aspect === 'experts')!;
    expect(experts.vramBytes).toBe(1 * GB);
    expect(weights.vramBytes).toBe(5 * GB);
    expect(weights.ramBytes).toBe(20 * GB);
    expect(weights.driver).toContain('experts of 48 layers in RAM');
    expect(parts.find((x) => x.aspect === 'working')!.ramBytes).toBe(512 * MB);
  });

  it('folds both pools into one on a Mac', () => {
    const p = plan({ unified: true, ram: { totalBytes: 0, otherBytes: 0, availBytes: 0, model: share(1 * GB) } });
    const parts = breakdown(p, {}, 32);
    expect(sumRam(parts)).toBe(0);
    expect(parts[0].vramBytes).toBe(9 * GB);
    expect(parts[0].driver).toBe('on the GPU, mapped from the file');
  });

  it('says how the weights load', () => {
    expect(weightsLoading({})).toBe('mapped from the file');
    expect(weightsLoading({ mmap: false })).toBe('read into memory');
    expect(weightsLoading({ mlock: true })).toBe('pinned, never paged out');
    // No KV type named: the engine's default, q8_0 (#3325).
    expect(contextDriver({ contextTokens: 8192, kvOnGpu: false })).toBe('1 session of 8k, standard (q8_0), kept in RAM');
    expect(contextDriver({ contextTokens: 8192, kvCacheDtype: 'f16' })).toBe('1 session of 8k, full (f16)');
  });
});

describe('livePools', () => {
  const gpu = { source: 'nvidia-smi', devices: [], totalMB: 24 * 1024, usedMB: 15 * 1024, freeMB: 9 * 1024 } as never;
  const system = { cpuPct: 10, cpuCores: 16, memUsedMB: 20 * 1024, memTotalMB: 64 * 1024 };

  it('puts every loaded model on the live readings, the rest as other apps', () => {
    const parts = breakdown(plan(), { contextTokens: 16384, parallelSlots: 2 }, 40);
    const pools = livePools({
      gpu,
      system,
      unified: false,
      models: [{ id: 'a', name: 'A', parts, fallbackBytes: 0 }],
      loading: [],
      reserveBytes: 512 * MB,
    });
    expect(pools.map((p) => p.key)).toEqual(['vram', 'ram']);
    const vram = pools[0];
    expect(vram.models[0].bytes).toBe(13 * GB);
    expect(vram.otherBytes).toBe(2 * GB);
    expect(vram.freeBytes).toBe(9 * GB);
    expect(vram.reserveAtBytes).toBe(24 * GB - 512 * MB);
    expect(vram.models[0].parts.find((p) => p.aspect === 'context')?.slices).toBe(2);
    // Nothing of it in RAM, so RAM is all other apps.
    expect(pools[1].models).toEqual([]);
    expect(pools[1].otherBytes).toBe(20 * GB);
  });

  it('trusts the measured graphics memory for the total and the planner for the split', () => {
    const parts = breakdown(plan(), {}, 40);
    const [vram] = livePools({
      gpu,
      system: null,
      unified: false,
      models: [{ id: 'a', name: 'A', parts, measuredVramBytes: 6.5 * GB, fallbackBytes: 0 }],
      loading: [],
      reserveBytes: null,
    });
    expect(vram.models[0].bytes).toBeCloseTo(6.5 * GB);
    expect(vram.models[0].parts[0].bytes).toBeCloseTo((8 / 13) * 6.5 * GB);
  });

  it('shows a model without a breakdown as one part, and a load as what has landed', () => {
    const [vram] = livePools({
      gpu,
      system: null,
      unified: false,
      models: [{ id: 'a', name: 'A', parts: null, fallbackBytes: 4 * GB, loadedOn: 'gpu' }],
      loading: [{ id: 'b', name: 'B', landedBytes: 2 * GB, needBytes: 5 * GB }],
      reserveBytes: null,
    });
    expect(vram.models.map((m) => [m.id, m.series, m.bytes])).toEqual([
      ['a', 0, 4 * GB],
      ['b', 1, 2 * GB],
    ]);
    expect(vram.models[1].loading).toEqual({ needBytes: 5 * GB });
    expect(vram.otherBytes).toBe(9 * GB);
  });

  it('draws one pool on a Mac and widens the scale when the numbers run past it', () => {
    const mac = { source: 'apple', devices: [], totalMB: 16 * 1024, usedMB: 15 * 1024, freeMB: 1024, unified: true } as never;
    const pools = livePools({
      gpu: mac,
      system,
      unified: true,
      models: [],
      loading: [{ id: 'b', name: 'B', landedBytes: 1 * GB, needBytes: 6 * GB }],
      reserveBytes: null,
    });
    expect(pools).toHaveLength(1);
    expect(pools[0].key).toBe('unified');
    expect(pools[0].scaleBytes).toBe(20 * GB);
  });
});
