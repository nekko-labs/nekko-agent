# Managed Inference Runtime Implementation Plan (AN7 phases A + B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a non-expert turn a local model server on, load a model into it, and see honestly whether it fits in VRAM before waiting for the load, with expert controls one disclosure away.

**Architecture:** Three units. A pure `packages/core/src/capacity/` planner does the VRAM math with no I/O. A `packages/host/src/runtimes/` control plane puts Ollama, LM Studio, and vLLM behind one `RuntimeAdapter` interface whose `capabilities` record (not its `kind`) tells the UI what to offer. The Models page renders local providers as runtime cards with a per-model fit drawer.

**Tech Stack:** existing monorepo (npm workspaces, TypeScript 7, Vitest 4). Host services in `packages/host`, shared contracts in `packages/shared`, renderer in `apps/desktop/src/renderer`. No new dependencies.

**Spec:** [docs/superpowers/specs/2026-09-09-managed-inference-runtime-design.md](../specs/2026-09-09-managed-inference-runtime-design.md)

## Global Constraints

- **No new dependencies.** Everything here is `fetch`, `child_process`, and `os`.
- **No em dash** in any prose, code comment, commit message, or UI copy.
- **No AI attribution** in commits or the PR description.
- **`unknown` is a valid answer.** Never infer capacity from a model's name. Missing metadata yields `verdict: 'unknown'`, not a guess.
- **Never sum unified memory with system RAM.** `HardwareFacts.unified` means one pool.
- **The UI asks capabilities, never kind.** No `if (kind === 'vllm')` in `apps/desktop/src/renderer`.
- **vLLM is connect-existing only.** No `start` implementation. Nothing unverifiable ships as a working button.
- **Stopping a process we do not own requires confirmation.** Owned processes stop without asking.
- IPC additions touch five files in order: `packages/shared/src/ipc.ts` (channel + `NekkoApi`), `packages/host/src/host.ts` (`Host` interface + impl), `packages/host/src/dispatch.ts` (table), `apps/desktop/src/preload/index.ts`, `apps/desktop/src/renderer/web-client.ts`. Missing one breaks either desktop or web silently.
- Run `npm test` and `npm run typecheck` from the repo root before each commit that touches types.

---

## File Structure

**Create:**
- `packages/shared/src/capacity.ts` - fit types (`ModelFacts`, `HardwareFacts`, `FitRequest`, `FitPlan`, `FitReason`, `FitSuggestion`, `KvCacheDtype`) shared by planner, host, and renderer.
- `packages/shared/src/runtimes.ts` - control-plane types plus the `RUNTIME_CAPABILITIES` table.
- `packages/core/src/capacity/kv.ts` - weight and KV-cache byte math.
- `packages/core/src/capacity/plan.ts` - `planFit()`, verdicts, reasons.
- `packages/core/src/capacity/suggest.ts` - ordered suggestions from a plan.
- `packages/core/src/capacity/index.ts` - re-exports.
- `packages/core/src/capacity/{kv,plan,suggest}.test.ts`
- `packages/host/src/runtimes/types.ts` - `RuntimeAdapter` interface.
- `packages/host/src/runtimes/ollama.ts`, `lmstudio.ts`, `vllm.ts` - adapters.
- `packages/host/src/runtimes/supervisor.ts` - owned child-process lifecycle.
- `packages/host/src/runtimes/calibration.ts` - overhead learning store.
- `packages/host/src/runtimes/index.ts` - `createRuntimes(providers)` service facade.
- `packages/host/src/runtimes/{ollama,lmstudio,vllm,supervisor,calibration}.test.ts`
- `apps/desktop/src/renderer/components/runtimes/{RuntimeCard,AddressField,FitBar,FitDrawer,AdvancedControls}.tsx`

**Modify:**
- `packages/shared/src/index.ts` - export the two new modules.
- `packages/shared/src/ipc.ts` - 6 new channels + `NekkoApi` methods.
- `packages/host/src/host.ts` - `Host` interface + implementations delegating to `createRuntimes`.
- `packages/host/src/dispatch.ts` - 6 table rows.
- `apps/desktop/src/preload/index.ts`, `apps/desktop/src/renderer/web-client.ts` - 6 passthroughs each.
- `apps/desktop/src/renderer/views/ModelsView.tsx` - local providers render `RuntimeCard`; existing cloud path untouched.

---

### Task 1: Shared capacity and runtime types

**Files:**
- Create: `packages/shared/src/capacity.ts`, `packages/shared/src/runtimes.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/runtimes.test.ts`

**Interfaces:**
- Produces: every type the rest of the plan uses. Exact names below are load-bearing.

- [ ] **Step 1: Write `packages/shared/src/capacity.ts`**

```ts
/** Fit-planning types. The math lives in @nekko-agent/core; these are the contracts. */

/** KV-cache element type. Halving the element halves the cache. */
export type KvCacheDtype = 'f16' | 'q8_0' | 'q4_0' | 'fp8';

export function kvBytesPerElement(dtype: KvCacheDtype): number {
  switch (dtype) {
    case 'f16': return 2;
    case 'q8_0': return 1;
    case 'fp8': return 1;
    case 'q4_0': return 0.5;
  }
}

/**
 * What we know about a model, normalized across runtimes. Every field past `id`
 * is optional on purpose: a missing field means the planner answers `unknown`
 * rather than inventing a number.
 */
export interface ModelFacts {
  id: string;
  providerId: string;
  /** Weights on disk / as loaded. The honest number, never paramCount x bits. */
  weightsBytes?: number;
  /** Transformer block count. */
  layers?: number;
  /** KV head count (grouped-query models have fewer than attention heads). */
  kvHeads?: number;
  /** Per-head dimension, embeddingLength / attentionHeadCount. */
  headDim?: number;
  /** The model's own maximum context. */
  maxContext?: number;
  /** e.g. "Q4_K_M", "fp8". Display only, never used to infer size. */
  quantization?: string;
  /** e.g. "8B". Display only. */
  parameterSize?: string;
  /** Currently resident. */
  loaded?: boolean;
  /** Measured VRAM while resident, when the runtime reports it. */
  vramBytes?: number;
  /** Context it was actually loaded with. */
  loadedContext?: number;
}

/** One memory pool the planner can place a model in. */
export interface CapacityDevice {
  name: string;
  totalBytes: number;
  freeBytes: number;
}

export interface HardwareFacts {
  devices: CapacityDevice[];
  /** GPU and CPU share one pool (Apple Silicon). Never add RAM on top. */
  unified: boolean;
  systemRamTotalBytes: number;
  systemRamFreeBytes: number;
}

export interface FitRequest {
  contextTokens: number;
  parallelSlots: number;
  kvCacheDtype: KvCacheDtype;
  /** 0..1 share of layers on GPU. 1 means all. */
  gpuLayerFraction: number;
}

export const DEFAULT_FIT_REQUEST: FitRequest = {
  contextTokens: 8192,
  parallelSlots: 1,
  kvCacheDtype: 'f16',
  gpuLayerFraction: 1,
};

export type FitVerdict = 'fits' | 'tight' | 'spills' | 'wont-load' | 'unknown';

export type FitReasonCode =
  | 'missing-metadata'
  | 'context-over-max'
  | 'kv-cache-dominates'
  | 'weights-exceed-device'
  | 'exceeds-total-memory'
  | 'headroom-thin'
  | 'unified-memory'
  | 'multi-device-not-pooled'
  | 'partial-offload';

/** A structured reason. The UI writes the sentence; we supply the numbers. */
export interface FitReason {
  code: FitReasonCode;
  /** Bytes the reason is about, when it is about bytes. */
  bytes?: number;
  /** Share of the budget, 0-100. */
  sharePct?: number;
  /** Free-text detail for codes that need one (a device name, a field name). */
  detail?: string;
}

/** A one-click fix. `apply` is a partial FitRequest to merge. */
export interface FitSuggestion {
  label: string;
  savesBytes?: number;
  apply?: Partial<FitRequest>;
  /** Suggests loading a different model id instead (a smaller quant). */
  alternateModelId?: string;
}

export interface FitPlan {
  verdict: FitVerdict;
  weightsBytes: number;
  kvCacheBytes: number;
  overheadBytes: number;
  requiredBytes: number;
  /** The device the plan is measured against, null when none is usable. */
  deviceName: string | null;
  deviceTotalBytes: number;
  deviceFreeBytes: number;
  /** Estimated layers resident on the GPU, and the model's total. */
  gpuLayers?: number;
  totalLayers?: number;
  /** Bytes expected to land in system RAM instead of VRAM. */
  spillBytes: number;
  reasons: FitReason[];
  suggestions: FitSuggestion[];
}

/** Measured residency after a load, kept beside the projection. */
export interface FitMeasurement {
  at: number;
  modelId: string;
  totalBytes: number;
  vramBytes: number;
  /** measured minus projected; positive means we under-estimated. */
  deltaBytes: number;
}
```

- [ ] **Step 2: Write `packages/shared/src/runtimes.ts`**

```ts
import type { ProviderKind } from './models.js';
import type { KvCacheDtype, ModelFacts } from './capacity.js';

/** The local model servers we manage. Mirrors LOCAL_PROVIDER_KINDS. */
export type RuntimeKind = 'ollama' | 'lmstudio' | 'vllm';

export function isRuntimeKind(kind: ProviderKind): kind is RuntimeKind {
  return kind === 'ollama' || kind === 'lmstudio' || kind === 'vllm';
}

/**
 * What a runtime can actually do. The renderer branches on these, never on the
 * kind, so a new runtime (a bundled engine) needs no UI changes.
 *
 * 'server-env' means the setting exists but only as a server-wide environment
 * variable, so changing it requires a restart. The UI says so.
 */
export interface RuntimeCapabilities {
  canStart: boolean;
  canStop: boolean;
  canLoad: boolean;
  canSetContext: boolean;
  canSetGpuLayers: boolean;
  canSetParallel: 'per-load' | 'server-env' | false;
  canSetKvCacheType: 'per-load' | 'server-env' | false;
  canSetTtl: boolean;
  /** Configuration is a launch command, not a control (vLLM). */
  configuredAtLaunch: boolean;
  /** Reports per-model VRAM, so measurements can reconcile the projection. */
  reportsPerModelVram: boolean;
}

export const RUNTIME_CAPABILITIES: Record<RuntimeKind, RuntimeCapabilities> = {
  ollama: {
    canStart: true, canStop: true, canLoad: true,
    canSetContext: true, canSetGpuLayers: true,
    canSetParallel: 'server-env', canSetKvCacheType: 'server-env',
    canSetTtl: true, configuredAtLaunch: false, reportsPerModelVram: true,
  },
  lmstudio: {
    canStart: true, canStop: true, canLoad: true,
    canSetContext: true, canSetGpuLayers: true,
    canSetParallel: false, canSetKvCacheType: false,
    canSetTtl: true, configuredAtLaunch: false, reportsPerModelVram: false,
  },
  // Connect-existing only: one model per process, configured at launch, and we
  // have no Linux + NVIDIA machine to verify a spawn path on.
  vllm: {
    canStart: false, canStop: true, canLoad: false,
    canSetContext: false, canSetGpuLayers: false,
    canSetParallel: false, canSetKvCacheType: false,
    canSetTtl: false, configuredAtLaunch: true, reportsPerModelVram: false,
  },
};

export interface RuntimeDetection {
  kind: RuntimeKind;
  /** The server answered a health probe. */
  running: boolean;
  /** A CLI or binary we could start it with was found. */
  installed: boolean;
  version?: string;
  /** Why we cannot start it, when installed is false. */
  reason?: string;
}

export interface ResidentModel {
  id: string;
  sizeBytes?: number;
  vramBytes?: number;
  contextLength?: number;
  expiresAt?: number;
}

export interface RuntimeStatus {
  kind: RuntimeKind;
  running: boolean;
  /** We spawned this process and hold its handle. */
  owned: boolean;
  version?: string;
  baseUrl: string;
  startedAt?: number;
  resident: ResidentModel[];
  /** Last lines of captured output, for a failed start. */
  log?: string[];
  error?: string;
  /** vLLM only: parsed /metrics highlights. */
  metrics?: RuntimeMetrics;
}

export interface RuntimeMetrics {
  kvCacheUsagePct?: number;
  requestsRunning?: number;
  requestsWaiting?: number;
}

export interface LoadParams {
  contextTokens?: number;
  gpuLayers?: number;
  kvCacheDtype?: KvCacheDtype;
  ttlSeconds?: number;
}

export interface StartOptions {
  baseUrl: string;
  /** Env applied to the spawned process (OLLAMA_NUM_PARALLEL and friends). */
  env?: Record<string, string>;
}

export interface StopResult {
  ok: boolean;
  message: string;
  /** We refused because the process is not ours; retry with force. */
  needsConfirmation?: boolean;
  /** What we would be killing, for the confirmation prompt. */
  processName?: string;
}

export interface LoadResult {
  ok: boolean;
  message?: string;
  facts?: ModelFacts;
}
```

- [ ] **Step 3: Export from `packages/shared/src/index.ts`**

Add beside the existing exports:

```ts
export * from './capacity.js';
export * from './runtimes.js';
```

- [ ] **Step 4: Write the capability-table test**

`packages/shared/src/runtimes.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { RUNTIME_CAPABILITIES, isRuntimeKind, kvBytesPerElement } from './index.js';

describe('RUNTIME_CAPABILITIES', () => {
  it('never offers to start vLLM', () => {
    expect(RUNTIME_CAPABILITIES.vllm.canStart).toBe(false);
    expect(RUNTIME_CAPABILITIES.vllm.canLoad).toBe(false);
    expect(RUNTIME_CAPABILITIES.vllm.configuredAtLaunch).toBe(true);
  });

  it('marks Ollama parallelism as restart-required, not per-load', () => {
    expect(RUNTIME_CAPABILITIES.ollama.canSetParallel).toBe('server-env');
    expect(RUNTIME_CAPABILITIES.ollama.canSetKvCacheType).toBe('server-env');
  });

  it('only claims per-model VRAM where a runtime reports it', () => {
    expect(RUNTIME_CAPABILITIES.ollama.reportsPerModelVram).toBe(true);
    expect(RUNTIME_CAPABILITIES.lmstudio.reportsPerModelVram).toBe(false);
  });

  it('treats every local provider kind as a runtime kind', () => {
    expect(isRuntimeKind('ollama')).toBe(true);
    expect(isRuntimeKind('openai-compat')).toBe(false);
  });
});

describe('kvBytesPerElement', () => {
  it('halves for q8_0 and quarters for q4_0', () => {
    expect(kvBytesPerElement('f16')).toBe(2);
    expect(kvBytesPerElement('q8_0')).toBe(1);
    expect(kvBytesPerElement('q4_0')).toBe(0.5);
  });
});
```

- [ ] **Step 5: Run and commit**

```bash
npm run test -w @nekko-agent/shared
git add packages/shared/src && git commit -m "feat(shared): capacity and runtime control-plane types"
```

---

### Task 2: KV-cache and weight math

**Files:**
- Create: `packages/core/src/capacity/kv.ts`, `packages/core/src/capacity/kv.test.ts`

**Interfaces:**
- Consumes: `ModelFacts`, `FitRequest`, `kvBytesPerElement` from Task 1.
- Produces: `kvCacheBytes(facts, request): number | null`, `estimateOverheadBytes(facts, request, overheadFloorBytes?): number`, `headDimOf(embeddingLength, headCount): number | undefined`.

- [ ] **Step 1: Write the failing test** (`kv.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import type { ModelFacts, FitRequest } from '@nekko-agent/shared';
import { kvCacheBytes, estimateOverheadBytes } from './kv.js';

const llama8b: ModelFacts = {
  id: 'llama3.1:8b', providerId: 'p1',
  weightsBytes: 4_920_000_000, layers: 32, kvHeads: 8, headDim: 128,
  maxContext: 131072, quantization: 'Q4_K_M',
};
const req: FitRequest = { contextTokens: 8192, parallelSlots: 1, kvCacheDtype: 'f16', gpuLayerFraction: 1 };

describe('kvCacheBytes', () => {
  it('computes 2 x layers x kvHeads x headDim x context x bytes x slots', () => {
    // 2 * 32 * 8 * 128 * 8192 * 2 * 1 = 1,073,741,824
    expect(kvCacheBytes(llama8b, req)).toBe(1_073_741_824);
  });

  it('multiplies by parallel slots, which is the whole point', () => {
    expect(kvCacheBytes(llama8b, { ...req, parallelSlots: 4 })).toBe(4 * 1_073_741_824);
  });

  it('halves for a q8_0 cache', () => {
    expect(kvCacheBytes(llama8b, { ...req, kvCacheDtype: 'q8_0' })).toBe(1_073_741_824 / 2);
  });

  it('returns null when the model geometry is unknown', () => {
    expect(kvCacheBytes({ id: 'x', providerId: 'p1', weightsBytes: 1 }, req)).toBeNull();
    expect(kvCacheBytes({ ...llama8b, kvHeads: undefined }, req)).toBeNull();
  });
});

describe('estimateOverheadBytes', () => {
  it('scales with context and never drops below the floor', () => {
    const small = estimateOverheadBytes(llama8b, { ...req, contextTokens: 512 });
    const large = estimateOverheadBytes(llama8b, { ...req, contextTokens: 131072 });
    expect(small).toBeGreaterThanOrEqual(256 * 1024 * 1024);
    expect(large).toBeGreaterThan(small);
  });

  it('honours a calibrated floor', () => {
    expect(estimateOverheadBytes(llama8b, req, 900_000_000)).toBeGreaterThanOrEqual(900_000_000);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm run test -w @nekko-agent/core -- capacity/kv
```
Expected: FAIL, cannot resolve `./kv.js`.

- [ ] **Step 3: Implement `kv.ts`**

```ts
import { kvBytesPerElement, type FitRequest, type ModelFacts } from '@nekko-agent/shared';

/**
 * KV-cache bytes for a model at a given context and parallelism.
 *
 *   2 (K and V) x layers x kvHeads x headDim x context x bytesPerElement x slots
 *
 * The `slots` term is why raising OLLAMA_NUM_PARALLEL can push a model that fit
 * yesterday onto the CPU today: every concurrent slot gets its own full cache.
 *
 * Returns null when the geometry is unknown. A null here becomes an `unknown`
 * verdict upstream, never a guess.
 */
export function kvCacheBytes(facts: ModelFacts, req: FitRequest): number | null {
  const { layers, kvHeads, headDim } = facts;
  if (!layers || !kvHeads || !headDim) return null;
  const slots = Math.max(1, req.parallelSlots);
  const ctx = Math.max(0, req.contextTokens);
  return 2 * layers * kvHeads * headDim * ctx * kvBytesPerElement(req.kvCacheDtype) * slots;
}

/** Below this, no runtime we know of loads anything at all. */
const OVERHEAD_FLOOR_BYTES = 256 * 1024 * 1024;

/**
 * Compute buffers, the graph, and the runtime's own reserve. There is no
 * published formula for this across three engines, so it is a floor plus a
 * context-proportional term, and `floorBytes` lets the calibration store replace
 * the constant with something measured on this machine.
 */
export function estimateOverheadBytes(
  facts: ModelFacts,
  req: FitRequest,
  floorBytes = OVERHEAD_FLOOR_BYTES,
): number {
  const perTokenGraph = (facts.layers ?? 32) * (facts.headDim ?? 128) * 64;
  const scaled = perTokenGraph * Math.min(req.contextTokens, 8192);
  return Math.max(floorBytes, OVERHEAD_FLOOR_BYTES) + scaled;
}

/** Per-head dimension from the two fields runtimes actually publish. */
export function headDimOf(embeddingLength?: number, headCount?: number): number | undefined {
  if (!embeddingLength || !headCount) return undefined;
  const d = Math.round(embeddingLength / headCount);
  return Number.isFinite(d) && d > 0 ? d : undefined;
}
```

- [ ] **Step 4: Run the test, expect PASS**

```bash
npm run test -w @nekko-agent/core -- capacity/kv
```

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/capacity && git commit -m "feat(core): KV-cache and overhead math for the fit planner"
```

---

### Task 3: planFit, verdicts and reasons

**Files:**
- Create: `packages/core/src/capacity/plan.ts`, `packages/core/src/capacity/plan.test.ts`

**Interfaces:**
- Consumes: `kvCacheBytes`, `estimateOverheadBytes` (Task 2); `FitPlan`, `FitReason`, `HardwareFacts` (Task 1).
- Produces: `planFit(facts: ModelFacts, req: FitRequest, hw: HardwareFacts, opts?: { overheadFloorBytes?: number }): FitPlan`.

- [ ] **Step 1: Write the failing test** (`plan.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import type { HardwareFacts, ModelFacts, FitRequest } from '@nekko-agent/shared';
import { planFit } from './plan.js';

const GB = 1024 ** 3;
const llama8b: ModelFacts = {
  id: 'llama3.1:8b', providerId: 'p1',
  weightsBytes: 4.9 * GB, layers: 32, kvHeads: 8, headDim: 128, maxContext: 131072,
};
const req: FitRequest = { contextTokens: 8192, parallelSlots: 1, kvCacheDtype: 'f16', gpuLayerFraction: 1 };

const rtx4090: HardwareFacts = {
  devices: [{ name: 'RTX 4090', totalBytes: 24 * GB, freeBytes: 23 * GB }],
  unified: false, systemRamTotalBytes: 64 * GB, systemRamFreeBytes: 40 * GB,
};
const macM3: HardwareFacts = {
  devices: [{ name: 'Apple M3 Max', totalBytes: 36 * GB, freeBytes: 22 * GB }],
  unified: true, systemRamTotalBytes: 36 * GB, systemRamFreeBytes: 22 * GB,
};
const cpuOnly: HardwareFacts = {
  devices: [], unified: false, systemRamTotalBytes: 16 * GB, systemRamFreeBytes: 12 * GB,
};

describe('planFit', () => {
  it('fits a small model on a big card', () => {
    const plan = planFit(llama8b, req, rtx4090);
    expect(plan.verdict).toBe('fits');
    expect(plan.deviceName).toBe('RTX 4090');
    expect(plan.spillBytes).toBe(0);
    expect(plan.requiredBytes).toBe(plan.weightsBytes + plan.kvCacheBytes + plan.overheadBytes);
  });

  it('spills when context blows past the card', () => {
    const plan = planFit(llama8b, { ...req, contextTokens: 131072 }, rtx4090);
    expect(plan.verdict).toBe('spills');
    expect(plan.spillBytes).toBeGreaterThan(0);
    expect(plan.reasons.map((r) => r.code)).toContain('kv-cache-dominates');
  });

  it('reports unknown rather than guessing when geometry is missing', () => {
    const plan = planFit({ id: 'mystery', providerId: 'p1', weightsBytes: 5 * GB }, req, rtx4090);
    expect(plan.verdict).toBe('unknown');
    expect(plan.reasons.map((r) => r.code)).toContain('missing-metadata');
  });

  it('never adds unified GPU memory on top of system RAM', () => {
    const plan = planFit(llama8b, req, macM3);
    expect(plan.deviceTotalBytes).toBe(36 * GB);
    expect(plan.reasons.map((r) => r.code)).toContain('unified-memory');
  });

  it('falls back to system RAM with a CPU-only machine', () => {
    const plan = planFit(llama8b, req, cpuOnly);
    expect(plan.deviceName).toBeNull();
    expect(plan.verdict).toBe('spills');
  });

  it('refuses a context above the model maximum', () => {
    const plan = planFit(llama8b, { ...req, contextTokens: 200_000 }, rtx4090);
    expect(plan.verdict).toBe('wont-load');
    expect(plan.reasons.map((r) => r.code)).toContain('context-over-max');
  });

  it('will not load when even system RAM cannot hold it', () => {
    const huge: ModelFacts = { ...llama8b, weightsBytes: 400 * GB };
    expect(planFit(huge, req, rtx4090).verdict).toBe('wont-load');
  });

  it('does not pool two discrete cards', () => {
    const dual: HardwareFacts = {
      devices: [
        { name: 'A', totalBytes: 12 * GB, freeBytes: 12 * GB },
        { name: 'B', totalBytes: 12 * GB, freeBytes: 12 * GB },
      ],
      unified: false, systemRamTotalBytes: 64 * GB, systemRamFreeBytes: 40 * GB,
    };
    const plan = planFit({ ...llama8b, weightsBytes: 20 * GB }, req, dual);
    expect(plan.deviceTotalBytes).toBe(12 * GB);
    expect(plan.reasons.map((r) => r.code)).toContain('multi-device-not-pooled');
  });

  it('counts free memory, not total, when something is already resident', () => {
    const busy: HardwareFacts = {
      devices: [{ name: 'RTX 4090', totalBytes: 24 * GB, freeBytes: 4 * GB }],
      unified: false, systemRamTotalBytes: 64 * GB, systemRamFreeBytes: 40 * GB,
    };
    expect(planFit(llama8b, req, busy).verdict).toBe('spills');
  });

  it('flags a fit with thin headroom as tight', () => {
    const snug: HardwareFacts = {
      devices: [{ name: 'RTX 3060', totalBytes: 12 * GB, freeBytes: 6.6 * GB }],
      unified: false, systemRamTotalBytes: 32 * GB, systemRamFreeBytes: 20 * GB,
    };
    expect(planFit(llama8b, { ...req, contextTokens: 2048 }, snug).verdict).toBe('tight');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm run test -w @nekko-agent/core -- capacity/plan
```

- [ ] **Step 3: Implement `plan.ts`**

Rules to encode, in this order:

1. If `contextTokens > facts.maxContext` (when known), verdict `wont-load` with `context-over-max`. Still fill the byte fields so the UI can show the breakdown.
2. Compute `kvCacheBytes`. Null, or missing `weightsBytes`, yields verdict `unknown` with a `missing-metadata` reason whose `detail` names the missing field. Byte fields are 0 and the UI shows "cannot tell".
3. Pick the budget device: the device with the largest `freeBytes`. `devices.length > 1 && !unified` adds a `multi-device-not-pooled` reason. `unified` adds a `unified-memory` reason and the budget is the single unified pool (never plus system RAM). No devices at all means `deviceName: null` and a budget of `systemRamFreeBytes`.
4. `requiredBytes = weights + kv + overhead`.
5. If `requiredBytes > systemRamFreeBytes + (deviceFreeBytes when discrete)`, verdict `wont-load` with `exceeds-total-memory`.
6. If `requiredBytes <= deviceFreeBytes`: `fits`, or `tight` when the leftover is under `HEADROOM_MARGIN` (768 MB) with a `headroom-thin` reason.
7. Otherwise `spills`: `spillBytes = requiredBytes - deviceFreeBytes`, `gpuLayers` estimated as `floor(layers * min(1, deviceFreeBytes_after_kv / weights))` clamped to `[0, layers]`, plus a `partial-offload` reason. When there is no device at all, the whole thing spills to CPU.
8. Add `kv-cache-dominates` whenever `kv > weights * 0.5`, carrying `bytes` and `sharePct`.
9. Add `weights-exceed-device` when `weights > deviceFreeBytes`.
10. `suggestions` are filled by Task 4, so `plan.ts` returns `suggestions: []` and `planFit` composes them. Keep `plan.ts` free of suggestion logic.

Honor `gpuLayerFraction < 1` by treating the device budget as `deviceFreeBytes * gpuLayerFraction` for placement, which is what "offload only half the layers" means to the user.

- [ ] **Step 4: Run the tests, expect all PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/capacity && git commit -m "feat(core): fit verdicts with an explicit unknown and no unified double-count"
```

---

### Task 4: Suggestions

**Files:**
- Create: `packages/core/src/capacity/suggest.ts`, `suggest.test.ts`, `packages/core/src/capacity/index.ts`
- Modify: `packages/core/src/index.ts` (export `./capacity/index.js`)

**Interfaces:**
- Consumes: `planFit` (Task 3).
- Produces: `suggestFixes(facts, req, hw, plan): FitSuggestion[]`, and a `planFit` that returns them populated.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import type { HardwareFacts, ModelFacts, FitRequest } from '@nekko-agent/shared';
import { planFit } from './plan.js';

const GB = 1024 ** 3;
const model: ModelFacts = {
  id: 'llama3.1:8b', providerId: 'p1',
  weightsBytes: 4.9 * GB, layers: 32, kvHeads: 8, headDim: 128, maxContext: 131072,
};
const hw: HardwareFacts = {
  devices: [{ name: 'RTX 4090', totalBytes: 24 * GB, freeBytes: 23 * GB }],
  unified: false, systemRamTotalBytes: 64 * GB, systemRamFreeBytes: 40 * GB,
};
const req: FitRequest = { contextTokens: 131072, parallelSlots: 1, kvCacheDtype: 'f16', gpuLayerFraction: 1 };

describe('suggestions', () => {
  it('offers a context that actually fits, and applying it fits', () => {
    const plan = planFit(model, req, hw);
    const ctx = plan.suggestions.find((s) => s.apply?.contextTokens);
    expect(ctx).toBeTruthy();
    const applied = planFit(model, { ...req, ...ctx!.apply }, hw);
    expect(['fits', 'tight']).toContain(applied.verdict);
  });

  it('offers a cheaper KV cache with the bytes it saves', () => {
    const plan = planFit(model, req, hw);
    const kv = plan.suggestions.find((s) => s.apply?.kvCacheDtype === 'q8_0');
    expect(kv?.savesBytes).toBeGreaterThan(0);
  });

  it('offers to cut parallel slots only when there is more than one', () => {
    const one = planFit(model, req, hw);
    expect(one.suggestions.some((s) => s.apply?.parallelSlots)).toBe(false);
    const four = planFit(model, { ...req, parallelSlots: 4 }, hw);
    expect(four.suggestions.some((s) => s.apply?.parallelSlots === 2)).toBe(true);
  });

  it('suggests nothing when the model already fits', () => {
    expect(planFit(model, { ...req, contextTokens: 4096 }, hw).suggestions).toHaveLength(0);
  });

  it('caps the list at three so the UI stays readable', () => {
    const plan = planFit(model, { ...req, parallelSlots: 8 }, hw);
    expect(plan.suggestions.length).toBeLessThanOrEqual(3);
  });
});
```

- [ ] **Step 2: Run, watch it fail. Step 3: Implement.**

`suggestFixes` returns nothing for `fits` and `unknown`. Otherwise, in benefit order:
- **Context**: binary-search the largest power-of-two-ish context in `[512, min(maxContext, current)]` whose re-plan is `fits` or `tight`. Label `Drop context to <human>` (`32k`, `16k`, `8k`).
- **KV dtype**: when `f16`, offer `q8_0` with `savesBytes = kv - kvAt(q8_0)`. Label `Use a q8_0 KV cache to save <n> GB`.
- **Parallel slots**: only when `parallelSlots > 1`, offer halving.
- **Alternate quant**: only when the caller passed sibling models. `suggestFixes` takes an optional `siblings: ModelFacts[]`; pick the largest sibling whose weights fit. Label `Load <id> instead`.

Sort by `savesBytes` descending, cap at 3. Every suggestion must be verified by re-planning inside the function, so a suggestion that would not actually help is never shown.

- [ ] **Step 4: Run tests. Step 5: Commit.**

```bash
git add packages/core/src/capacity packages/core/src/index.ts
git commit -m "feat(core): fit suggestions that are re-planned before being offered"
```

---

### Task 5: Ollama adapter

**Files:**
- Create: `packages/host/src/runtimes/types.ts`, `packages/host/src/runtimes/ollama.ts`, `ollama.test.ts`

**Interfaces:**
- Consumes: Task 1 types.
- Produces: `RuntimeAdapter` interface (exact shape in the spec) and `ollamaAdapter: RuntimeAdapter`.

- [ ] **Step 1: Write `types.ts`** with the `RuntimeAdapter` interface exactly as the spec defines it, plus `RuntimeContext { fetch: typeof fetch; run: (cmd, args, timeoutMs?) => Promise<string | null> }` so tests inject stubs instead of hitting the network. Every adapter is a factory: `createOllamaAdapter(ctx: RuntimeContext): RuntimeAdapter`.

- [ ] **Step 2: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { createOllamaAdapter } from './ollama.js';

const PS = {
  models: [{
    name: 'llama3.1:8b', model: 'llama3.1:8b',
    size: 6_000_000_000, size_vram: 4_000_000_000,
    context_length: 8192, expires_at: '2026-09-09T12:00:00Z',
    details: { parameter_size: '8B', quantization_level: 'Q4_K_M' },
  }],
};
const SHOW = {
  details: { parameter_size: '8B', quantization_level: 'Q4_K_M' },
  model_info: {
    'llama.block_count': 32,
    'llama.attention.head_count': 32,
    'llama.attention.head_count_kv': 8,
    'llama.embedding_length': 4096,
    'llama.context_length': 131072,
  },
};

function ctxWith(routes: Record<string, unknown>) {
  return {
    fetch: (async (url: string) => {
      const key = Object.keys(routes).find((k) => String(url).includes(k));
      if (!key) return { ok: false, status: 404, json: async () => ({}) } as any;
      return { ok: true, status: 200, json: async () => routes[key] } as any;
    }) as unknown as typeof fetch,
    run: async () => null,
  };
}

describe('ollama adapter', () => {
  it('reads geometry out of the architecture-prefixed model_info map', async () => {
    const a = createOllamaAdapter(ctxWith({ '/api/show': SHOW, '/api/ps': PS, '/api/tags': { models: [{ name: 'llama3.1:8b' }] } }));
    const [facts] = await a.listModels('http://localhost:11434');
    expect(facts.layers).toBe(32);
    expect(facts.kvHeads).toBe(8);
    expect(facts.headDim).toBe(128); // 4096 / 32
    expect(facts.maxContext).toBe(131072);
  });

  it('treats size_vram below size as a CPU spill', async () => {
    const a = createOllamaAdapter(ctxWith({ '/api/ps': PS }));
    const status = await a.status('http://localhost:11434');
    expect(status.resident[0].vramBytes).toBe(4_000_000_000);
    expect(status.resident[0].sizeBytes).toBe(6_000_000_000);
  });

  it('reports not running when the health probe fails', async () => {
    const a = createOllamaAdapter(ctxWith({}));
    expect((await a.detect('http://localhost:11434')).running).toBe(false);
  });

  it('sends num_ctx and num_gpu when loading', async () => {
    const bodies: string[] = [];
    const a = createOllamaAdapter({
      fetch: (async (_u: string, init?: RequestInit) => {
        if (init?.body) bodies.push(String(init.body));
        return { ok: true, status: 200, json: async () => ({}) } as any;
      }) as unknown as typeof fetch,
      run: async () => null,
    });
    await a.load!('http://localhost:11434', 'llama3.1:8b', { contextTokens: 16384, gpuLayers: 20, ttlSeconds: 600 });
    const body = JSON.parse(bodies[0]);
    expect(body.options.num_ctx).toBe(16384);
    expect(body.options.num_gpu).toBe(20);
    expect(body.keep_alive).toBe('600s');
  });
});
```

- [ ] **Step 3: Implement `ollama.ts`.** Notes that will bite otherwise:
  - `model_info` keys are architecture-prefixed (`llama.block_count`, `qwen3.block_count`). Match on the suffix after the first dot, not on a hardcoded prefix.
  - `headDim = embedding_length / attention.head_count`, using `headDimOf` from Task 2.
  - `detect` probes `GET /api/version` for `running` plus the version string; `installed` shells `ollama --version` through `ctx.run`.
  - `load` is `POST /api/generate` with `{ model, prompt: '', keep_alive, options: { num_ctx, num_gpu } }`. `unload` is the same call with `keep_alive: 0`.
  - `listModels` merges `/api/tags` (everything on disk) with `/api/ps` (resident) and enriches each with `/api/show`. Cap concurrent `show` calls at 4 and cache per model id for 60s: a 40-model library otherwise fires 40 requests on every 6s poll.

- [ ] **Step 4: Run tests. Step 5: Commit.**

```bash
npm run test -w @nekko-agent/host -- runtimes/ollama
git add packages/host/src/runtimes && git commit -m "feat(host): Ollama runtime adapter with real model geometry"
```

---

### Task 6: LM Studio adapter

**Files:**
- Create: `packages/host/src/runtimes/lmstudio.ts`, `lmstudio.test.ts`
- Reuse: `packages/host/src/lms.ts` (T99) for `lmsProbe` / `lmsLoad` / `lmsUnload`

**Interfaces:**
- Produces: `createLmStudioAdapter(ctx: RuntimeContext): RuntimeAdapter`.

- [ ] **Step 1: Write the failing test** covering: `/api/v0/models` parsed into `ModelFacts` with `state === 'loaded'` mapping to `loaded`; `start` invoking `lms server start` and `stop` invoking `lms server stop` (assert on the recorded `run` calls, not on a real process); `detect` reporting `installed: false` with a reason when `lms` is absent; `load` passing `--context-length` and `--gpu`.

- [ ] **Step 2: Run, fail. Step 3: Implement.** Notes:
  - Base URL carries a `/v1` suffix; the native API is at the root, so strip it exactly as `lmStudioModels()` in `openai-compat.ts` already does.
  - Start is `lms server start --port <port>`; stop is `lms server stop`. Both are only valid for a **localhost** instance, which `lmsProbe` already determines. A remote LM Studio reports `canStart` false through `detect().reason`, not through the static capability table.
  - `load` maps `contextTokens` to `--context-length` and `gpuLayers` to `--gpu <fraction>` (LM Studio takes a 0..1 fraction or `max`/`off`, not a layer count, so convert with `gpuLayers / totalLayers`).
  - Keep the T99 lesson: `lms` exits 0 on "Model Not Found", so success is exit-0 **and** output not matching the failure phrases.

- [ ] **Step 4: Run tests. Step 5: Commit.**

---

### Task 7: vLLM adapter (connect-existing only)

**Files:**
- Create: `packages/host/src/runtimes/vllm.ts`, `vllm.test.ts`

**Interfaces:**
- Produces: `createVllmAdapter(ctx: RuntimeContext): RuntimeAdapter` with **no `start`**, and `parseVllmMetrics(text: string): RuntimeMetrics`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { parseVllmMetrics } from './vllm.js';

const METRICS = `
# HELP vllm:num_requests_running Number of requests currently running.
# TYPE vllm:num_requests_running gauge
vllm:num_requests_running{model_name="meta-llama/Llama-3.1-8B"} 2.0
vllm:num_requests_waiting{model_name="meta-llama/Llama-3.1-8B"} 5.0
vllm:kv_cache_usage_perc{model_name="meta-llama/Llama-3.1-8B"} 0.734
`;

describe('parseVllmMetrics', () => {
  it('pulls the three numbers that matter out of Prometheus text', () => {
    const m = parseVllmMetrics(METRICS);
    expect(m.requestsRunning).toBe(2);
    expect(m.requestsWaiting).toBe(5);
    expect(m.kvCacheUsagePct).toBeCloseTo(73.4, 1);
  });

  it('ignores HELP and TYPE lines and survives an empty body', () => {
    expect(parseVllmMetrics('')).toEqual({});
    expect(parseVllmMetrics('# HELP x y')).toEqual({});
  });
});
```

Add a second test asserting `createVllmAdapter(ctx).start` is `undefined`, which is the contract that keeps the UI from offering a start button.

- [ ] **Step 2: Run, fail. Step 3: Implement.** `listModels` reads `/v1/models`, marks every served model `loaded: true` (vLLM serves exactly what it was launched with), and leaves geometry `undefined` unless the response carries it. `status` fetches `/metrics` and tolerates a 404, since `--disable-log-stats` turns it off.

- [ ] **Step 4: Run tests. Step 5: Commit.**

---

### Task 8: Supervisor

**Files:**
- Create: `packages/host/src/runtimes/supervisor.ts`, `supervisor.test.ts`

**Interfaces:**
- Produces: `createSupervisor()` returning `{ start(id, cmd, args, opts), stop(id), isOwned(id), status(id), logs(id) }`.

- [ ] **Step 1: Write the failing test.** Against a stub child (a `node -e` one-liner that listens on a port), assert: a started process is `isOwned`; `logs` captures stderr; `stop` on an owned process resolves `ok: true` without touching `stopLocalServer`; `stop` on an id we never started returns `needsConfirmation: true` rather than killing anything; a start that fails immediately surfaces the captured stderr in `RuntimeStatus.error`.

- [ ] **Step 2: Run, fail. Step 3: Implement.** Notes:
  - Keep owned children in a `Map<string, { child, startedAt, log: string[] }>`; the log is a ring buffer capped at 200 lines.
  - Health-poll the base URL every 500 ms up to a 60 s budget before declaring the start failed. A cold `ollama serve` on a slow disk is genuinely slow.
  - Stop is SIGTERM, then SIGKILL after 3 s, then remove from the map. On Windows use `taskkill /PID <pid> /T /F`, matching `servers.ts`.
  - Register a `process.on('exit')` handler that kills every owned child, so quitting Nekko Agent does not leave orphaned servers.
  - `stop` for an unowned runtime returns `{ ok: false, needsConfirmation: true, processName }` where `processName` comes from the PID on the port. Only a second call with `force: true` routes to the existing `stopLocalServer`.

- [ ] **Step 4: Run tests. Step 5: Commit.**

---

### Task 9: Calibration and the runtimes facade

**Files:**
- Create: `packages/host/src/runtimes/calibration.ts`, `calibration.test.ts`, `packages/host/src/runtimes/index.ts`

**Interfaces:**
- Produces: `createRuntimes(deps)` exposing `detect(providerId)`, `status(providerId)`, `start(providerId)`, `stop(providerId, force?)`, `load(providerId, modelId, params)`, `unload(providerId, modelId)`, `plan(providerId, modelId, request)`, `facts(providerId)`.
- `plan()` is the join point: it gathers `ModelFacts` from the adapter, `HardwareFacts` from `getGpuStats()` + `getSystemStats()`, applies the calibrated overhead floor, and calls `planFit`.

- [ ] **Step 1: Write the failing calibration test.** Assert: a fresh store returns the default floor; recording a measurement moves the floor toward the residual by the EMA factor, not all the way; an absurd residual (negative, or above 8 GB) is discarded; a runtime version change resets the record.

- [ ] **Step 2: Run, fail. Step 3: Implement.** `calibration.ts` persists `runtime-calibration.json` in the data dir via the existing `paths.ts` helper, keyed `${kind}:${version}`, holding `{ overheadFloorBytes, samples }` with an EMA factor of 0.3.

`index.ts` builds `HardwareFacts` from `GpuStats`:
```ts
// GpuStats reports megabytes; capacity types are bytes throughout.
const devices = (gpu?.devices ?? []).map((d) => ({
  name: d.name,
  totalBytes: d.memoryTotalMB * 1024 * 1024,
  freeBytes: d.memoryFreeMB * 1024 * 1024,
}));
const hw: HardwareFacts = {
  devices,
  unified: Boolean(gpu?.unified),
  systemRamTotalBytes: (sys?.memTotalMB ?? 0) * 1024 * 1024,
  systemRamFreeBytes: ((sys?.memTotalMB ?? 0) - (sys?.memUsedMB ?? 0)) * 1024 * 1024,
};
```

- [ ] **Step 4: Run tests. Step 5: Commit.**

---

### Task 10: IPC wiring

**Files:**
- Modify: `packages/shared/src/ipc.ts`, `packages/host/src/host.ts`, `packages/host/src/dispatch.ts`, `apps/desktop/src/preload/index.ts`, `apps/desktop/src/renderer/web-client.ts`

**Interfaces:**
- Produces, on `window.nekko`:
```ts
runtimeStatus(providerId: string): Promise<RuntimeStatus | null>;
runtimeStart(providerId: string): Promise<RuntimeStatus | { error: string }>;
runtimeStop(providerId: string, force?: boolean): Promise<StopResult>;
runtimeLoad(providerId: string, modelId: string, params: LoadParams): Promise<LoadResult>;
runtimeFacts(providerId: string): Promise<ModelFacts[]>;
runtimePlan(providerId: string, modelId: string, req: FitRequest): Promise<FitPlan | null>;
```

- [ ] **Step 1: Add channels** to `IpcChannels`: `runtimeStatus: 'runtime:status'`, `runtimeStart: 'runtime:start'`, `runtimeStop: 'runtime:stop'`, `runtimeLoad: 'runtime:load'`, `runtimeFacts: 'runtime:facts'`, `runtimePlan: 'runtime:plan'`.
- [ ] **Step 2: Add the six signatures** to the `NekkoApi` interface in the same file.
- [ ] **Step 3: Add them to the `Host` interface** and implement in `createHost` by delegating to `createRuntimes`. Leave the existing `loadModel` / `unloadModel` / `stopServer` in place: the phone client and older surfaces call them.
- [ ] **Step 4: Add six rows** to the `dispatch.ts` table, six passthroughs to `preload/index.ts`, six to `web-client.ts`.
- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git commit -am "feat(host): runtime control-plane IPC across desktop and web"
```

---

### Task 11: RuntimeCard and AddressField

**Files:**
- Create: `apps/desktop/src/renderer/components/runtimes/RuntimeCard.tsx`, `AddressField.tsx`
- Modify: `apps/desktop/src/renderer/views/ModelsView.tsx`

- [ ] **Step 1: `AddressField.tsx`.** Monospace value, a copy button that swaps to a check for 1.2 s, and an inline edit (pencil, then an input with Save/Cancel) that calls `providersSave` with the new `baseUrl` and re-runs detection. Escape cancels, Enter saves.
- [ ] **Step 2: `RuntimeCard.tsx`.** Header row: name, status dot (green running, amber starting, grey stopped, red error), version, uptime. Power toggle driven by `capabilities.canStart`: a working switch when true, and a "Connect only" chip with a tooltip when false. Under it, `AddressField`, then a VRAM bar for the card's device with resident models segmented in, then resident model rows. On a failed start, render the last log lines in a collapsible `<pre>`.
- [ ] **Step 3: Wire into `ModelsView.tsx`.** In `ProviderCard`, when `isLocalProvider(provider.kind)`, render `RuntimeCard` above the existing model list. Cloud providers are untouched. Keep the existing 6 s poll and feed it `runtimeStatus`.
- [ ] **Step 4: Verify over the Local Web UI** (`npm run web`), then commit.

---

### Task 12: FitBar, FitDrawer, AdvancedControls

**Files:**
- Create: `apps/desktop/src/renderer/components/runtimes/{FitBar,FitDrawer,AdvancedControls}.tsx`

- [ ] **Step 1: `FitBar.tsx`.** A single horizontal bar, segments weights / KV cache / overhead / free, coloured by verdict (green fits, amber tight, orange spills, red wont-load, hatched grey unknown). Each segment has a title with its byte size. A spill draws past the device edge with a marker line at the device boundary, so "over the line" is literal.
- [ ] **Step 2: `FitDrawer.tsx`.** Opens from a model row. Simple layer: a context slider (512 to `maxContext`, log scale, snapping to 1k boundaries), the `FitBar`, a one-line verdict rendered from `plan.reasons`, up to three suggestion chips that apply their `FitRequest` delta on click, and a Load button. Debounce `runtimePlan` at 150 ms while dragging.
- [ ] **Step 3: Verdict copy.** A pure `verdictSentence(plan): string` in the drawer's module, unit-tested, mapping reasons to plain language, for example: `Runs on your RTX 4090 with 3.1 GB to spare.` / `12 of 32 layers will run on the CPU, roughly 4x slower, because the KV cache needs 14.2 GB at 64k context.` / `Cannot tell: Ollama did not report this model's layer count.` No em dash in any string.
- [ ] **Step 4: `AdvancedControls.tsx`.** Collapsed `<details>`. Quantization picker when siblings exist, parallel slots, KV cache dtype, GPU layer fraction, TTL. Any control whose capability is `'server-env'` renders disabled with a "restart required" note and a copyable env line. When `configuredAtLaunch`, render the generated `vllm serve` command instead of controls, with a copy button.
- [ ] **Step 5: Test `verdictSentence` and commit.**

---

### Task 13: Docs, SPEC, TASKS

- [ ] **Step 1:** Add a "Running models locally" section to `SPEC.md` describing the runtime cards, the fit planner, and the vLLM connect-existing boundary. Mark phases C and D as planned.
- [ ] **Step 2:** In `TASKS.md`, mark **AN7** in progress, add tasks **T149** (control plane) and **T150** (fit planner) with what shipped, and note C/D as follow-ons.
- [ ] **Step 3:** Write `docs/local-models.md`: what each runtime supports, what the verdicts mean, why a model spills to CPU, and how to change parallelism.
- [ ] **Step 4:** Commit.

---

### Task 14: Live verification

- [ ] **Step 1:** `npm run typecheck && npm test && npm run build:web` from the root, all green.
- [ ] **Step 2:** Against real Ollama on this Mac: start it from the card, load a model with a chosen context, confirm the projection lands near the measured `size_vram`, and drag context until the bar goes red.
- [ ] **Step 3:** Against real LM Studio: server start/stop through `lms`, load/unload, address copy and edit.
- [ ] **Step 4:** Confirm the unified-memory path never shows a budget larger than system RAM.
- [ ] **Step 5:** Capture before/after screenshots of the Models page for the PR, per `AGENTS.md`.

---

## Self-Review

**Spec coverage.** Adapters (T5-7), supervisor and ownership (T8), calibration and reconciliation (T9), planner math (T2), verdicts including `unknown` and unified memory (T3), suggestions (T4), capabilities table (T1), runtime card with power/address/VRAM (T11), fit drawer with simple and advanced layers (T12), errors surfaced from captured stderr (T8, T11), testing strategy (throughout, plus T14). Covered.

**Placeholders.** None. Tasks 3, 5, 6, 8, 9 give numbered implementation rules rather than full listings, which is deliberate: the tests above them define the contract exactly, and the rules name every branch. The tricky parsing (architecture-prefixed `model_info`, Prometheus text, the `lms` exit-0 trap) has code or explicit notes.

**Type consistency.** `ModelFacts`, `FitRequest`, `FitPlan`, `HardwareFacts`, `RuntimeAdapter`, `RuntimeCapabilities`, `LoadParams`, `StopResult`, `LoadResult` are defined once in Task 1 and used unchanged after. `kvCacheBytes` / `estimateOverheadBytes` / `headDimOf` (T2) are consumed under those names in T3 and T9. `planFit` (T3) is consumed in T4 and T9. `createRuntimes` (T9) is consumed in T10. The six IPC method names in T10 match their uses in T11 and T12.

**One gap found and closed:** Task 4's `suggestFixes` needs sibling models for the alternate-quant suggestion, which `planFit` does not otherwise have. Resolved by making `siblings` an optional parameter, so the core signature stays pure and the host passes the provider's model list when it has one.
