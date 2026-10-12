import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { expect, it } from 'vitest';
import { autoFit, estimateOverheadBytes, headDimOf, kvCacheBytes, planFit } from '@nekko-agent/core';
import { DEFAULT_FIT_REQUEST, type FitRequest, type HardwareFacts, type ModelFacts } from '@nekko-agent/shared';

/**
 * The capacity planner (core's `planFit`, `autoFit` and the KV and overhead
 * estimates) as the runtime control plane uses it, which the engine daemon's
 * port (crates/nekko-engine `capacity`) must reproduce as text, key order
 * included. Writes crates/nekko-engine/tests/golden/capacity.json; fails if it
 * is stale (rewrite with UPDATE_GOLDEN=1).
 */
const golden = join(__dirname, '..', '..', '..', '..', 'crates', 'nekko-engine', 'tests', 'golden', 'capacity.json');

const GB = 1024 ** 3;
const MB = 1024 ** 2;

const MODELS: ModelFacts[] = [
  { id: 'qwen3:8b-q4_K_M', providerId: 'p', weightsBytes: 5.2 * GB, layers: 36, kvHeads: 8, headDim: 128, maxContext: 40960, quantization: 'Q4_K_M', parameterSize: '8B' },
  { id: 'qwen3:8b-q8_0', providerId: 'p', weightsBytes: 8.9 * GB, layers: 36, kvHeads: 8, headDim: 128, maxContext: 40960 },
  { id: 'qwen3:8b-q3', providerId: 'p', weightsBytes: 4.1 * GB, layers: 36, kvHeads: 8, headDim: 128, maxContext: 40960 },
  { id: 'llama70b', providerId: 'p', weightsBytes: 42 * GB, layers: 80, kvHeads: 8, headDim: 128, maxContext: 131072 },
  { id: 'gemma-small', providerId: 'p', weightsBytes: 2.4 * GB, layers: 26, kvHeads: 4, headDim: 256, maxContext: 8192 },
  { id: 'no-geometry', providerId: 'p', weightsBytes: 3 * GB },
  { id: 'nothing', providerId: 'p' },
  { id: 'huge-no-geom', providerId: 'p', weightsBytes: 900 * GB },
  { id: 'zero-layers', providerId: 'p', weightsBytes: GB, layers: 0, kvHeads: 8, headDim: 128 },
  { id: 'tiny-ctx', providerId: 'p', weightsBytes: 0.3 * GB, layers: 12, kvHeads: 12, headDim: 64, maxContext: 1000 },
  { id: 'kv-heavy', providerId: 'p', weightsBytes: 1 * GB, layers: 64, kvHeads: 32, headDim: 128, maxContext: 262144 },
];

const HARDWARE: HardwareFacts[] = [
  { devices: [{ name: 'RTX 5090', totalBytes: 32 * GB, freeBytes: 29 * GB }], unified: false, systemRamTotalBytes: 64 * GB, systemRamFreeBytes: 40 * GB },
  { devices: [{ name: 'GTX 1050', totalBytes: 2 * GB, freeBytes: 1.7 * GB }, { name: 'RX 580', totalBytes: 8 * GB, freeBytes: 7.3 * GB }], unified: false, systemRamTotalBytes: 16 * GB, systemRamFreeBytes: 9 * GB },
  { devices: [{ name: 'Apple M2', totalBytes: 16 * GB, freeBytes: 9 * GB }], unified: true, systemRamTotalBytes: 16 * GB, systemRamFreeBytes: 9 * GB },
  { devices: [], unified: false, systemRamTotalBytes: 8 * GB, systemRamFreeBytes: 5.5 * GB },
  { devices: [{ name: 'RTX 3060', totalBytes: 12 * GB, freeBytes: 6.25 * GB + 123 * MB }], unified: false, systemRamTotalBytes: 32 * GB, systemRamFreeBytes: 1 * GB },
];

const REQUESTS: FitRequest[] = [
  DEFAULT_FIT_REQUEST,
  { contextTokens: 32768, parallelSlots: 4, kvCacheDtype: 'f16', gpuLayerFraction: 1 },
  { contextTokens: 131072, parallelSlots: 1, kvCacheDtype: 'q8_0', gpuLayerFraction: 0.5 },
  { contextTokens: 4096, parallelSlots: 0, kvCacheDtype: 'q4_0', gpuLayerFraction: 1.7 },
  { contextTokens: 65536, parallelSlots: 2, kvCacheDtype: 'fp8', gpuLayerFraction: Number.NaN },
];

it('the capacity planner matches the daemon golden set', () => {
  const plans = [];
  const fits = [];
  for (const facts of MODELS) {
    for (const [h, hw] of HARDWARE.entries()) {
      for (const [r, req] of REQUESTS.entries()) {
        const opts = r === 2 ? { overheadFloorBytes: 900 * MB, siblings: MODELS } : { siblings: MODELS };
        plans.push({ model: facts.id, hw: h, req: r, plan: JSON.stringify(planFit(facts, req, hw, opts)) });
      }
      for (const [budgetFraction, parallelSlots, maxContextTokens] of [[0.5, undefined, undefined], [1, 4, undefined], [0.05, 2, 6000], [Number.NaN, 1, 300]] as const) {
        fits.push({
          model: facts.id,
          hw: h,
          budgetFraction: Number.isNaN(budgetFraction) ? 'NaN' : budgetFraction,
          parallelSlots: parallelSlots ?? null,
          maxContextTokens: maxContextTokens ?? null,
          result: JSON.stringify(autoFit({ facts, hardware: hw, budgetFraction, parallelSlots, maxContextTokens, options: { overheadFloorBytes: 300 * MB, siblings: MODELS } })),
        });
      }
    }
  }
  const out = {
    models: MODELS,
    hardware: HARDWARE,
    requests: REQUESTS.map((r) => ({ ...r, gpuLayerFraction: Number.isNaN(r.gpuLayerFraction) ? 'NaN' : r.gpuLayerFraction })),
    kv: MODELS.map((m) => REQUESTS.map((r) => kvCacheBytes(m, r))),
    overhead: MODELS.map((m) => REQUESTS.map((r) => estimateOverheadBytes(m, r))),
    headDim: [[4096, 32], [3584, 28], [undefined, 8], [100, 0], [5120, 3]].map(([e, h]) => headDimOf(e, h) ?? null),
    plans,
    fits,
  };
  if (process.env.UPDATE_GOLDEN) {
    mkdirSync(dirname(golden), { recursive: true });
    writeFileSync(golden, `${JSON.stringify(out, null, 1)}\n`);
  }
  expect(JSON.parse(readFileSync(golden, 'utf8'))).toEqual(JSON.parse(JSON.stringify(out)));
});
