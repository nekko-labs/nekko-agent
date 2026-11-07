import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { retryUntilAnswered } from './retryUntilAnswered.js';

const down = () => Promise.reject(new Error('Nekko service did not become ready.'));

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('retryUntilAnswered', () => {
  it('asks once when the first try answers', async () => {
    const attempt = vi.fn(async () => {});
    retryUntilAnswered(attempt);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(attempt).toHaveBeenCalledWith(false);
  });

  it('keeps asking until it answers, says so, then stops', async () => {
    let up = false;
    const attempt = vi.fn((_retried: boolean) => (up ? Promise.resolve() : down()));
    retryUntilAnswered(attempt);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(attempt).toHaveBeenCalledTimes(3);
    up = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(attempt).toHaveBeenCalledTimes(4);
    expect(attempt).toHaveBeenLastCalledWith(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempt).toHaveBeenCalledTimes(4);
  });

  it('stops waiting when stopped', async () => {
    const attempt = vi.fn(down);
    const stop = retryUntilAnswered(attempt);
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('does not start again when stopped with a try in flight', async () => {
    let fail: (e: Error) => void = () => {};
    const attempt = vi.fn(() => new Promise<void>((_, reject) => { fail = reject; }));
    const stop = retryUntilAnswered(attempt);
    stop();
    fail(new Error('late'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});
