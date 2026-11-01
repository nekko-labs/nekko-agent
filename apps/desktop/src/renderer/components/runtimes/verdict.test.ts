import { describe, expect, it } from 'vitest';
import type { FitPlan } from '@nekko-agent/shared';
import { formatBytes, formatCount, formatTokens, verdictNotes, verdictSentence } from './verdict.js';

const GB = 1024 ** 3;

function plan(over: Partial<FitPlan>): FitPlan {
  return {
    verdict: 'fits',
    weightsBytes: 5 * GB,
    kvCacheBytes: 1 * GB,
    overheadBytes: 0.4 * GB,
    requiredBytes: 6.4 * GB,
    deviceName: 'RTX 4090',
    deviceTotalBytes: 24 * GB,
    deviceFreeBytes: 23 * GB,
    spillBytes: 0,
    reasons: [],
    suggestions: [],
    ...over,
  };
}

describe('verdictSentence', () => {
  it('says where it runs and what is left over when it fits', () => {
    const s = verdictSentence(plan({}));
    expect(s).toContain('RTX 4090');
    expect(s).toContain('to spare');
  });

  it('names the layers that land on the CPU and why', () => {
    const s = verdictSentence(
      plan({
        verdict: 'spills',
        gpuLayers: 20,
        totalLayers: 32,
        spillBytes: 4 * GB,
        kvCacheBytes: 14.2 * GB,
        reasons: [{ code: 'kv-cache-dominates', bytes: 14.2 * GB }],
      }),
    );
    expect(s).toContain('12 of 32 layers will run on the CPU');
    expect(s).toContain('14.2 GB');
    expect(s).toContain('slower');
  });

  it('admits it cannot tell, and names the missing field', () => {
    const s = verdictSentence(
      plan({
        verdict: 'unknown',
        weightsBytes: 0,
        reasons: [{ code: 'missing-metadata', detail: 'layer count' }],
      }),
    );
    expect(s).toContain('Cannot tell');
    expect(s).toContain('layer count');
  });

  it('quotes the model maximum when the context is over it', () => {
    const s = verdictSentence(
      plan({ verdict: 'wont-load', reasons: [{ code: 'context-over-max', detail: '131072' }] }),
    );
    expect(s).toContain('128k');
  });

  it('says a CPU-only machine has no GPU rather than implying one', () => {
    const s = verdictSentence(plan({ deviceName: null, reasons: [{ code: 'no-gpu' }] }));
    expect(s).toContain('CPU');
    expect(s).toContain('no GPU');
  });

  it('warns about thin headroom without calling it a failure', () => {
    const s = verdictSentence(plan({ verdict: 'tight', deviceFreeBytes: 6.6 * GB }));
    expect(s).toContain('to spare');
    expect(s).toContain('may start spilling');
  });

  it('never uses an em dash', () => {
    const verdicts: FitPlan['verdict'][] = ['fits', 'tight', 'spills', 'wont-load', 'unknown'];
    for (const v of verdicts) {
      expect(verdictSentence(plan({ verdict: v, gpuLayers: 4, totalLayers: 32 }))).not.toContain('—');
    }
  });
});

describe('verdictNotes', () => {
  it('explains unified memory without claiming double the capacity', () => {
    const notes = verdictNotes(plan({ reasons: [{ code: 'unified-memory' }] }));
    expect(notes[0]).toContain('one memory pool');
  });

  it('explains that two cards are not one big card', () => {
    const notes = verdictNotes(plan({ reasons: [{ code: 'multi-device-not-pooled', detail: '2' }] }));
    expect(notes[0]).toContain('2 GPUs');
    expect(notes[0]).toContain('fit on one');
  });

  it('shows nothing when there is nothing to explain', () => {
    expect(verdictNotes(plan({}))).toHaveLength(0);
  });
});

describe('formatting', () => {
  it('keeps byte sizes readable at every scale', () => {
    expect(formatBytes(512 * 1024 * 1024)).toBe('512 MB');
    expect(formatBytes(4.93 * GB)).toBe('4.9 GB');
    expect(formatBytes(23 * GB)).toBe('23.0 GB');
    expect(formatBytes(400 * GB)).toBe('400 GB');
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(400 * 1024)).toBe('400 KB');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
  });

  it('compacts large counts without "1000k"', () => {
    expect(formatCount(999_600)).toBe(new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(999_600));
    expect(formatCount(999_600)).not.toMatch(/1000/);
    expect(formatCount(42)).toBe('42');
    expect(formatCount(Number.NaN)).toBe('0');
  });

  it('shows context in the units people think in', () => {
    expect(formatTokens(8192)).toBe('8k');
    expect(formatTokens(131072)).toBe('128k');
    expect(formatTokens(512)).toBe('512');
  });
});

describe('verdictSentence with partial metadata', () => {
  it('reports the weights it does know instead of a flat cannot-tell', () => {
    const s = verdictSentence(
      plan({
        verdict: 'unknown',
        weightsBytes: 29.5 * GB,
        kvCacheBytes: 0,
        reasons: [{ code: 'missing-metadata', detail: 'layer count' }],
      }),
    );
    // 29.5 GB of weights against 23 GB free: the weights alone already overflow,
    // which is worth saying even though the total is unprojectable.
    expect(s).toContain('29.5 GB');
    expect(s).toContain('more than RTX 4090 has free');
    expect(s).toContain('layer count');
  });

  it('says the weights fit when they do, while still admitting the total is unknown', () => {
    const s = verdictSentence(
      plan({
        verdict: 'unknown',
        weightsBytes: 10 * GB,
        kvCacheBytes: 0,
        reasons: [{ code: 'missing-metadata', detail: 'layer count' }],
      }),
    );
    expect(s).toContain('fits in RTX 4090');
    expect(s).toContain('cannot be projected');
  });

  it('still says cannot tell when it knows nothing at all', () => {
    const s = verdictSentence(
      plan({ verdict: 'unknown', weightsBytes: 0, reasons: [{ code: 'missing-metadata', detail: 'weights size' }] }),
    );
    expect(s).toContain('Cannot tell');
  });
});
