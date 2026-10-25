import { describe, expect, it } from 'vitest';
import type { Recommendation } from '@nekko-agent/shared';
import {
  contextPerSession,
  contextStops,
  expertCacheMiB,
  fromPreset,
  fromRecommendation,
  keepOf,
  keepParams,
  runOnOf,
  toPlacementRequest,
} from './loadSettings.js';

const moe = { layers: 48, sizeBytes: 45 * 1024 ** 3, weightLayout: { expertShare: 21 / 45, ffnShare: 0, tableShare: 21 / 45 } };

describe('load settings', () => {
  it('defaults thinking on and retains the local model Expert override', () => {
    expect(fromPreset().params.thinking !== false).toBe(true);
    expect(fromPreset({}).params.thinking !== false).toBe(true);
    expect(fromPreset({ thinking: false }).params.thinking).toBe(false);
    expect(fromPreset({ thinking: true }).params.thinking).toBe(true);
  });

  it('reads where it runs off the launch parameters', () => {
    expect(runOnOf({}, 48)).toBe('gpu');
    expect(runOnOf({ gpuLayers: 48 }, 48)).toBe('gpu');
    expect(runOnOf({ gpuLayers: 0 }, 48)).toBe('cpu');
    expect(runOnOf({ gpuLayers: 20 }, 48)).toBe('hybrid');
    expect(runOnOf({ gpuLayers: 48, cpuMoeLayers: 40 }, 48)).toBe('hybrid');
    expect(runOnOf({ gpuLayers: 48, kvOnGpu: false }, 48)).toBe('hybrid');
  });

  it('shows context per session and launches the whole pool', () => {
    expect(contextPerSession({ contextTokens: 131072, parallelSlots: 2 })).toBe(65536);
    const rec = { runOn: 'hybrid', contextTokens: 65536, sessions: 2, kvCacheDtype: 'q8_0', gpuLayers: 48, cpuMoeLayers: 40, cpuFfnLayers: 0, kvOnGpu: true, mmap: true, pin: false, tablesOnDisk: true, moeCacheBytes: 0 } as Recommendation['request'];
    const p = fromRecommendation(rec, moe);
    expect(p).toMatchObject({ contextTokens: 131072, parallelSlots: 2, cpuMoeLayers: 40, gpuLayers: 48, lazyTables: true, ttlSeconds: 0 });
    expect(toPlacementRequest(p, moe)).toMatchObject({ runOn: 'hybrid', contextTokens: 65536, sessions: 2, cpuMoeLayers: 40, tablesOnDisk: true });
  });

  it('keeps settings the solver does not decide', () => {
    const rec = { runOn: 'gpu', contextTokens: 32768, sessions: 1, kvCacheDtype: 'f16', gpuLayers: 48, cpuMoeLayers: 0, cpuFfnLayers: 0, kvOnGpu: true, mmap: true, pin: false, tablesOnDisk: true, moeCacheBytes: 0 } as Recommendation['request'];
    const p = fromRecommendation(rec, moe, { thinking: false, seed: 7, mlock: true, ttlSeconds: 0, cpuMoeLayers: 10 });
    expect(p.seed).toBe(7);
    expect(p.thinking).toBe(false);
    expect(p.mlock).toBe(true);
    expect(p.cpuMoeLayers).toBeUndefined();
    expect(p.parallelSlots).toBeUndefined();
  });

  it('maps keep in memory onto the idle limit and pinning', () => {
    for (const level of [0, 1, 2]) expect(keepOf(keepParams(level))).toBe(level);
  });

  it('offers the model maximum as the last context stop', () => {
    expect(contextStops(40960).at(-1)).toBe(40960);
    expect(contextStops(262144).at(-1)).toBe(262144);
  });

  it('strips the drawer-only fields of a saved preset', () => {
    expect(fromPreset({ contextTokens: 8192, budgetFraction: 0.75, splitPreset: 'experts' })).toEqual({ params: { contextTokens: 8192 }, split: 'experts' });
  });

  it('sizes the expert cache from spare VRAM, and skips a tiny one', () => {
    const plan = { spareVramBytes: 1024 ** 3 } as Parameters<typeof expertCacheMiB>[0];
    expect(expertCacheMiB(plan, moe)).toBe(1024);
    expect(expertCacheMiB({ ...plan, spareVramBytes: 100 * 1024 ** 2 }, moe)).toBeUndefined();
  });
});
