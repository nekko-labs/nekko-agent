import type { FitPlan, FitReason, ResidentModel } from '@nekko-agent/shared';

/**
 * Turning a projection into one sentence a person can act on.
 *
 * The planner deliberately produces structured reasons rather than prose, so this
 * is the only place the wording lives. Keeping it pure and separate means the
 * sentence can be tested against the numbers that produced it, and reworded
 * without touching the math.
 */

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const gb = n / 1024 ** 3;
  // Keep the decimal below 100 GB. On a 16 GB card the gap between "14 GB" and
  // "14.2 GB" is the gap between fitting and not, so rounding it away costs the
  // reader the one digit they need.
  if (gb >= 100) return `${Math.round(gb)} GB`;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  // Below a megabyte (a tokenizer, a small adapter) the MB figure rounded to 0.
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${Math.round(n)} B`;
}

/** A count for a badge: 999,600 reads "1M", not "1000k"; locale-aware. */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_048_576).toFixed(1)}M`;
  if (n >= 1024) return `${Math.round(n / 1024)}k`;
  return String(n);
}

function reason(plan: FitPlan, code: FitReason['code']): FitReason | undefined {
  return plan.reasons.find((r) => r.code === code);
}

/** The headline sentence under the fit bar. */
export function verdictSentence(plan: FitPlan): string {
  const where = plan.deviceName ?? 'system memory';

  if (plan.verdict === 'unknown') {
    const missing = reason(plan, 'missing-metadata')?.detail;
    const what = missing
      ? `this server did not report the model's ${missing}`
      : 'this server did not report enough about the model';
    // When the weights are known the answer is partial, not absent, and saying so
    // is more useful than a flat "cannot tell".
    if (plan.weightsBytes > 0) {
      const fitsWeights = plan.weightsBytes <= plan.deviceFreeBytes;
      return `The weights are ${formatBytes(plan.weightsBytes)}, which ${
        fitsWeights ? `fits in ${where}` : `is more than ${where} has free`
      }. The total cannot be projected because ${what}.`;
    }
    return `Cannot tell: ${what}.`;
  }

  if (plan.verdict === 'wont-load') {
    const overMax = reason(plan, 'context-over-max');
    if (overMax) {
      return `This model tops out at ${formatTokens(Number(overMax.detail ?? 0))} of context.`;
    }
    return `Will not load: it needs ${formatBytes(plan.requiredBytes)}, which is more memory than this machine has free.`;
  }

  if (plan.verdict === 'spills') {
    const layers =
      plan.gpuLayers !== undefined && plan.totalLayers
        ? `${plan.totalLayers - plan.gpuLayers} of ${plan.totalLayers} layers will run on the CPU`
        : `${formatBytes(plan.spillBytes)} will run on the CPU`;
    const because = reason(plan, 'kv-cache-dominates')
      ? `, because the KV cache alone needs ${formatBytes(plan.kvCacheBytes)}`
      : `, because ${where} has ${formatBytes(plan.deviceFreeBytes)} free and this needs ${formatBytes(plan.requiredBytes)}`;
    return `${capitalize(layers)}${because}. Expect it to be several times slower.`;
  }

  const spare = Math.max(0, plan.deviceFreeBytes - plan.requiredBytes);
  if (plan.verdict === 'tight') {
    return `Fits on ${where}, but with only ${formatBytes(spare)} to spare. A long conversation may start spilling.`;
  }

  if (!plan.deviceName) {
    return `Runs on the CPU using ${formatBytes(plan.requiredBytes)} of system memory. There is no GPU here to use.`;
  }
  return `Runs entirely on ${where}, using ${formatBytes(plan.requiredBytes)} with ${formatBytes(spare)} to spare.`;
}

/** Secondary notes worth showing under the headline, at most two. */
export function verdictNotes(plan: FitPlan): string[] {
  const notes: string[] = [];
  if (reason(plan, 'unified-memory')) {
    notes.push('This Mac shares one memory pool between the CPU and GPU, so the budget is system memory.');
  }
  const multi = reason(plan, 'multi-device-not-pooled');
  if (multi) {
    notes.push(
      `You have ${multi.detail} GPUs, but a model has to fit on one of them unless the server splits it across both.`,
    );
  }
  return notes.slice(0, 2);
}

/** Colour token for a verdict, shared by the bar and the badge. */
export function verdictColor(verdict: FitPlan['verdict']): string {
  switch (verdict) {
    case 'fits':
      return 'var(--success)';
    case 'tight':
      return 'var(--warning, #d1a054)';
    case 'spills':
      return 'var(--warning, #d1a054)';
    case 'wont-load':
      return 'var(--danger)';
    case 'unknown':
      return 'var(--ink-faint)';
  }
}

export function verdictLabel(verdict: FitPlan['verdict']): string {
  switch (verdict) {
    case 'fits':
      return 'Fits';
    case 'tight':
      return 'Tight';
    case 'spills':
      return 'Spills to CPU';
    case 'wont-load':
      return 'Will not load';
    case 'unknown':
      return 'Unknown';
  }
}

/**
 * Where a resident model actually sits: all in VRAM, split across GPU and CPU,
 * or entirely on the CPU. Layer counts come along when the engine reported
 * them, because "40/61 layers" says more than "GPU + CPU" alone.
 */
export function placementLabel(r: ResidentModel): string {
  const layers =
    r.gpuLayers !== undefined && r.totalLayers !== undefined
      ? ` · ${r.gpuLayers}/${r.totalLayers} layers`
      : '';
  switch (r.loadedOn) {
    case 'gpu':
      return `on GPU${layers}`;
    case 'gpu+cpu':
      return `GPU + CPU${layers}`;
    case 'cpu':
      return 'on CPU';
    default:
      return '';
  }
}

export function placementTitle(r: ResidentModel): string {
  switch (r.loadedOn) {
    case 'gpu':
      return 'Every layer is resident in VRAM.';
    case 'gpu+cpu':
      return 'Some layers run on the CPU, which is slower than a full GPU offload.';
    case 'cpu':
      return 'It runs entirely in system RAM on the CPU.';
    default:
      return '';
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
