import { describe, expect, it } from 'vitest';
import { prefetchSessionPrs } from './prefetchSessionPrs.js';

describe('visible sidebar PR prefetch', () => {
  it('continues past eight cards, bounds parallelism and skips cached cards', async () => {
    const loaded: Record<string, unknown> = { cached: [] };
    const inFlight = new Map<string, Promise<void>>();
    const ids = ['', 'cached', ...Array.from({ length: 25 }, (_, i) => `s${i}`)];
    const seen: string[] = [];
    let active = 0, peak = 0;
    await prefetchSessionPrs(ids, () => loaded, async (id) => {
      seen.push(id); active++; peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 1));
      loaded[id] = []; active--;
    }, inFlight, () => false);
    expect(seen).toEqual(ids.slice(2));
    expect(peak).toBe(8);
    expect(inFlight.size).toBe(0);
  });

  it('stops scheduling hidden/unmounted rows and releases failed reads without a retry loop', async () => {
    let cancelled = false;
    const seen: string[] = [];
    const inFlight = new Map<string, Promise<void>>();
    await prefetchSessionPrs(Array.from({ length: 20 }, (_, i) => `s${i}`), () => ({}), async (id) => {
      seen.push(id); cancelled = true; throw Error('unavailable');
    }, inFlight, () => cancelled);
    expect(seen.length).toBeLessThanOrEqual(8);
    expect(new Set(seen).size).toBe(seen.length);
    expect(inFlight.size).toBe(0);
  });

  it('dedupes and bounds reads across overlapping effects', async () => {
    const loaded: Record<string, unknown> = {};
    const inFlight = new Map<string, Promise<void>>();
    const seen: string[] = [];
    let active = 0, peak = 0;
    const refresh = async (id: string) => {
      seen.push(id); peak = Math.max(peak, ++active);
      await new Promise(r => setTimeout(r, 1));
      loaded[id] = []; active--;
    };
    const ids = Array.from({ length: 25 }, (_, i) => `s${i}`);
    await Promise.all([
      prefetchSessionPrs(ids.slice(0, 20), () => loaded, refresh, inFlight, () => false),
      prefetchSessionPrs(ids.slice(5), () => loaded, refresh, inFlight, () => false),
    ]);
    expect([...seen].sort()).toEqual([...ids].sort());
    expect(peak).toBeLessThanOrEqual(8);
    expect(inFlight.size).toBe(0);
  });
});
