import { describe, expect, it } from 'vitest';
import type { PrInfo } from '@nekko-agent/shared';
import { freshSessionPrs, prefetchSessionPrs } from './prefetchSessionPrs.js';

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

describe('batched PR prefetch', () => {
  it('reads the visible cards together, 24 to a request, skipping loaded and in-flight ones', async () => {
    const loaded: Record<string, unknown> = { cached: [] };
    const inFlight = new Map<string, Promise<void>>([['busy', Promise.resolve()]]);
    const ids = ['', 'cached', 'busy', 's0', ...Array.from({ length: 29 }, (_, i) => `s${i + 1}`), 's0'];
    const calls: string[][] = [];
    await prefetchSessionPrs(ids, () => loaded, async () => { throw Error('not one by one'); }, inFlight, () => false, async (batch) => {
      calls.push(batch);
      expect([...batch].every((id) => inFlight.has(id))).toBe(true);
    });
    expect(calls.map((c) => c.length)).toEqual([24, 6]);
    expect(calls.flat()).toEqual(Array.from({ length: 30 }, (_, i) => `s${i}`));
    expect(inFlight.has('s0')).toBe(false);
    expect(inFlight.size).toBe(1);
  });

  it('stops between requests when cancelled and releases a failed request', async () => {
    let cancelled = false;
    const inFlight = new Map<string, Promise<void>>();
    const calls: string[][] = [];
    await prefetchSessionPrs(Array.from({ length: 60 }, (_, i) => `s${i}`), () => ({}), async () => {}, inFlight, () => cancelled, async (batch) => {
      calls.push(batch); cancelled = true; throw Error('unavailable');
    });
    expect(calls).toHaveLength(1);
    expect(inFlight.size).toBe(0);
  });
});

describe('agent cards re-read PRs that can still change', () => {
  const info = (state: 'open' | 'merged' | 'closed') => ({ url: 'u', owner: 'o', repo: 'r', number: 1, title: 't', state, isDraft: false, additions: 0, deletions: 0, changedFiles: 0, checks: 'none', source: 'gh' }) as PrInfo;
  it('treats final PRs and recently read open PRs as loaded, and drops stale open ones', () => {
    const now = 1_000_000;
    const fresh = freshSessionPrs({
      done: [info('merged'), info('closed')],
      none: [],
      justRead: [info('open')],
      stale: [info('open'), info('merged')],
      neverRead: [info('open')],
    }, new Map([['justRead', now - 10_000], ['stale', now - 45_000]]), now);
    expect(Object.keys(fresh).sort()).toEqual(['done', 'justRead', 'none']);
  });
});
