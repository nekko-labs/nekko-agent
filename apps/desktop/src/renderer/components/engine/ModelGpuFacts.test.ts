import { describe, expect, it } from 'vitest';
import { capacityBands } from './GpuCapacityBar.js';
import { busyNote, contextText, contextThatFits, DESKTOP_RESERVE_BYTES } from './ModelGpuFacts.js';

const GB = 1024 ** 3;
const maxCtx = 262144;
// A 27B Q4_K_M on a 32 GB card: 15.7 GB of weights, about 68 MB of KV per 1k tokens.
const plan = { weightsBytes: 15.7 * GB, overheadBytes: 0.6 * GB, kvCacheBytes: (68 * 1024 ** 2) * (maxCtx / 1024) };

describe('ModelGpuFacts', () => {
  it('gives a model that only the busy GPU cannot hold its context on a free GPU', () => {
    const total = 31.8 * GB;
    const now = contextThatFits(plan, 12.7 * GB, maxCtx)!;
    const empty = contextThatFits(plan, total - DESKTOP_RESERVE_BYTES, maxCtx)!;
    expect(now).toBe(0);
    expect(empty).toBeGreaterThan(180 * 1024);
    expect(empty).toBeLessThan(maxCtx);
    expect(contextText(now, maxCtx)).toBe('None');
    expect(contextText(empty, maxCtx)).toMatch(/^\d+k of 256k$/);
    expect(busyNote(total - 12.7 * GB, ['sd3.5-large'], now, empty)).toBe('sd3.5-large and other apps hold 19.1 GB of the GPU right now. Unload it to give this model the room.');
  });

  it('says nothing about who holds the GPU when the model fits now as well as it ever will', () => {
    expect(busyNote(10 * GB, ['other'], maxCtx, maxCtx)).toBeNull();
    expect(busyNote(1 * GB, [], 100, 200)).toBeNull();
  });

  it('names other apps when no model of ours holds the GPU', () => {
    expect(busyNote(8 * GB, [], 0, 1000)).toMatch(/^Other apps hold 8(\.0)? GB of the GPU right now\. Close them/);
  });

  it('reads the full context as All', () => expect(contextText(maxCtx, maxCtx)).toBe('All 256k'));
});


describe('GPU capacity bar', () => {
  const geometry = { weightsBytes: 7 * GB, overheadBytes: GB, kvCacheBytes: 8 * GB };
  const widths = (free: number, rec: number | null = 8192, max = 32768) => Object.fromEntries(
    capacityBands(geometry, free * GB, max, rec).map(b => [b.id, b.bytes / GB]));
  it('counts only the added context between stops and leaves actual headroom at the end', () => {
    expect(widths(20)).toEqual({ model: 8, min: 1, rec: 1, max: 6, free: 4 });
    expect(widths(16)).not.toHaveProperty('free');
  });
  it('splits at the byte budget, even inside minimum context or inside the model', () => {
    expect(widths(12)).toEqual({ model: 8, min: 1, rec: 1, max: 2, short: 4 });
    expect(widths(8.5)).toEqual({ model: 8, min: 0.5, rec: 0, max: 0, short: 7.5 });
    expect(widths(4)).toEqual({ model: 4, min: 0, rec: 0, max: 0, short: 12 });
  });
  it('keeps coincident milestones without charging twice or inventing an unknown recommendation', () => {
    expect(widths(16, 2048, 2048)).toEqual({ model: 8, min: 8, rec: 0, max: 0 });
    expect(widths(16, null)).not.toHaveProperty('rec');
  });
});
