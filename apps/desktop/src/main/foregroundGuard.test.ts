import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANSWER_MS, POLL_MS, createForegroundGuard, holdNotices } from './foregroundGuard.js';

afterEach(() => { vi.useRealTimers(); });

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe('foreground guard', () => {
  it('goes ahead at once with nothing full-screen, with our own window focused, or without an answer', async () => {
    const free = createForegroundGuard({ ask: async () => ({ quiet: false }), ownFocus: () => false });
    const fn = vi.fn(); await free.whenFree(fn); expect(fn).toHaveBeenCalledOnce();
    // A game cannot be in front while one of our windows has focus.
    const ask = vi.fn(async () => ({ quiet: true }));
    const ours = createForegroundGuard({ ask, ownFocus: () => true });
    const g = vi.fn(); await ours.whenFree(g); expect(g).toHaveBeenCalledOnce(); expect(ask).not.toHaveBeenCalled();
    // Service stopped or erroring: today's behavior.
    const down = createForegroundGuard({ ask: () => Promise.reject(new Error('stopped')), ownFocus: () => false });
    const h = vi.fn(); await down.whenFree(h); expect(h).toHaveBeenCalledOnce();
  });

  it('treats a slow answer as none', async () => {
    vi.useFakeTimers();
    const guard = createForegroundGuard({ ask: () => new Promise(() => {}), ownFocus: () => false });
    const fn = vi.fn(); const done = guard.whenFree(fn);
    await vi.advanceTimersByTimeAsync(ANSWER_MS);
    await done; expect(fn).toHaveBeenCalledOnce();
  });

  it('holds while a full-screen app is in front and runs everything held once it is gone', async () => {
    vi.useFakeTimers();
    let quiet = true;
    const guard = createForegroundGuard({ ask: async () => ({ quiet }), ownFocus: () => false });
    const a = vi.fn(); const b = vi.fn();
    await guard.whenFree(a); await guard.whenFree(b);
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(a).not.toHaveBeenCalled(); expect(b).not.toHaveBeenCalled();
    quiet = false;
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(a).toHaveBeenCalledOnce(); expect(b).toHaveBeenCalledOnce();
    // Nothing waits any more, so nothing is asked.
    guard.dispose();
  });

  it('drops what is held on dispose', async () => {
    vi.useFakeTimers();
    const ask = vi.fn(async () => ({ quiet: true }));
    const guard = createForegroundGuard({ ask, ownFocus: () => false });
    const fn = vi.fn(); await guard.whenFree(fn);
    guard.dispose();
    const asked = ask.mock.calls.length;
    await vi.advanceTimersByTimeAsync(POLL_MS * 5);
    expect(fn).not.toHaveBeenCalled(); expect(ask).toHaveBeenCalledTimes(asked);
  });
});

describe('held notices', () => {
  const notice = (sessionId: string, kind: string, title = kind) => ({ sessionId, kind, title });

  it('posts at once when nothing is full-screen', async () => {
    const post = vi.fn();
    const hold = holdNotices(createForegroundGuard({ ask: async () => ({ quiet: false }), ownFocus: () => false }), post);
    hold(notice('s1', 'finished')); await flush();
    expect(post).toHaveBeenCalledWith(notice('s1', 'finished'));
  });

  it('delivers one notice per chat and kind, the newest, once the game is gone', async () => {
    vi.useFakeTimers();
    let quiet = true;
    const post = vi.fn();
    const hold = holdNotices(createForegroundGuard({ ask: async () => ({ quiet }), ownFocus: () => false }), post);
    hold(notice('s1', 'approval', 'first')); await flush();
    hold(notice('s1', 'approval', 'second'));
    hold(notice('s1', 'finished'));
    hold(notice('s2', 'finished'));
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(post).not.toHaveBeenCalled();
    quiet = false;
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(post.mock.calls.map(([n]) => `${n.sessionId}:${n.title}`)).toEqual(['s1:second', 's1:finished', 's2:finished']);
    // Later notices go straight out again.
    hold(notice('s3', 'finished')); await flush();
    expect(post).toHaveBeenCalledTimes(4);
  });
});
