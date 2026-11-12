import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IssueInfo, PrInfo } from '@nekko-agent/shared';
import { resetPrInfoCache, watchInfo } from './PrLinkChip.js';

const url = 'https://github.com/o/r/pull/1';
const pr = (patch: Partial<PrInfo> = {}): PrInfo => ({ url, owner: 'o', repo: 'r', number: 1, title: 't', state: 'open', isDraft: false, additions: 0, deletions: 0, changedFiles: 0, checks: 'none', source: 'gh', ...patch });

type Listener = () => void;
let doc: { hidden: boolean; listeners: Map<string, Set<Listener>> };
let win: { listeners: Map<string, Set<Listener>> };
const target = (store: Map<string, Set<Listener>>) => ({
  addEventListener: (type: string, fn: Listener) => { if (!store.has(type)) store.set(type, new Set()); store.get(type)!.add(fn); },
  removeEventListener: (type: string, fn: Listener) => { store.get(type)?.delete(fn); },
});
const fire = (store: Map<string, Set<Listener>>, type: string) => store.get(type)?.forEach((fn) => fn());
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

beforeEach(() => {
  vi.useFakeTimers();
  doc = { hidden: false, listeners: new Map() };
  win = { listeners: new Map() };
  vi.stubGlobal('document', Object.assign(doc, target(doc.listeners)));
  vi.stubGlobal('window', Object.assign(win, target(win.listeners)));
  resetPrInfoCache();
});
afterEach(() => {
  resetPrInfoCache();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('PR chips keep their state current while shown', () => {
  it('an open PR that merges updates the chip after the next tick', async () => {
    let state: PrInfo = pr();
    const read = vi.fn(async () => state);
    const seen: Array<string | undefined> = [];
    const stop = watchInfo(url, read, (info) => seen.push(info?.state));
    await flush();
    expect(seen).toEqual(['open']);
    state = pr({ state: 'merged' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(seen).toEqual(['open', 'merged']);
    stop();
  });

  it('a merged or closed PR is final and is never read again', async () => {
    const read = vi.fn(async () => pr({ state: 'merged' }));
    const stop = watchInfo(url, read, () => {});
    await flush();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    fire(win.listeners, 'focus');
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
    expect(win.listeners.get('focus')?.size ?? 0).toBe(0);
    stop();
  });

  it('a hidden window does not poll, and becoming visible re-reads at once', async () => {
    const read = vi.fn(async () => pr());
    const stop = watchInfo(url, read, () => {});
    await flush();
    doc.hidden = true;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(read).toHaveBeenCalledTimes(1);
    doc.hidden = false;
    fire(doc.listeners, 'visibilitychange');
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
    stop();
  });

  it('many chips for one PR share one read per tick, and focus right after a read asks nothing', async () => {
    const read = vi.fn(async () => pr());
    const stops = Array.from({ length: 12 }, () => watchInfo(url, read, () => {}));
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
    fire(win.listeners, 'focus');
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(win.listeners.get('focus')?.size).toBe(1);
    stops.forEach((stop) => stop());
  });

  it('stops the shared timer once no chip shows an open PR', async () => {
    const read = vi.fn(async () => pr());
    const stop = watchInfo(url, read, () => {});
    await flush();
    expect(win.listeners.get('focus')?.size).toBe(1);
    stop();
    expect(win.listeners.get('focus')?.size ?? 0).toBe(0);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('an open issue in the plan sheet refreshes the same way until it closes', async () => {
    const issueUrl = 'https://github.com/o/r/issues/2';
    let state: IssueInfo = { kind: 'issue', url: issueUrl, owner: 'o', repo: 'r', number: 2, title: 'i', state: 'open' } as IssueInfo;
    const read = vi.fn(async () => state);
    const seen: Array<string | undefined> = [];
    const stop = watchInfo(issueUrl, read, (info) => seen.push(info?.state));
    await flush();
    state = { ...state, state: 'closed' };
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(seen).toEqual(['open', 'closed']);
    expect(read).toHaveBeenCalledTimes(2);
    stop();
  });
});
