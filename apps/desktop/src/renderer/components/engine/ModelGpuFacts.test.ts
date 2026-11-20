import { describe, expect, it } from 'vitest';
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
