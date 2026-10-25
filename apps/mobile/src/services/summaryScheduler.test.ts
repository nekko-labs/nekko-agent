import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSummaryScheduler } from './summaryScheduler';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup() {
  const requests: ReturnType<typeof deferred<number>>[] = [];
  const fetch = vi.fn(() => {
    const request = deferred<number>();
    requests.push(request);
    return request.promise;
  });
  const apply = vi.fn();
  return { requests, fetch, apply, scheduler: createSummaryScheduler(fetch, apply) };
}

const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

describe('summary scheduling', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('coalesces a burst of done/session_meta invalidations into one debounced fetch', async () => {
    const { scheduler, fetch, requests, apply } = setup();
    scheduler.schedule();
    await tick(300);
    scheduler.schedule();
    scheduler.schedule();
    await tick(299);
    expect(fetch).not.toHaveBeenCalled();
    await tick(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    requests[0].resolve(0);
    await tick();
    expect(apply).toHaveBeenCalledExactlyOnceWith(0);
    await tick(6000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('fetches the latest watch count after session_meta arrives during a pending full refresh', async () => {
    const { scheduler, fetch, requests, apply } = setup();
    const refresh = scheduler.refresh();
    await tick();
    // The first snapshot has watch=1; session_meta invalidates it to watch=0.
    scheduler.schedule();
    scheduler.schedule();
    await tick(1200);
    expect(fetch).toHaveBeenCalledTimes(1);
    requests[0].resolve(1);
    await refresh;
    expect(apply).not.toHaveBeenCalled();
    await tick(600);
    expect(fetch).toHaveBeenCalledTimes(2);
    requests[1].resolve(0);
    await tick();
    expect(apply).toHaveBeenCalledExactlyOnceWith(0);
    await tick(6000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('serializes manual refresh with a pending scheduled request', async () => {
    const { scheduler, fetch, requests, apply } = setup();
    scheduler.schedule();
    await tick(600);
    const refresh = scheduler.refresh();
    await tick(600);
    expect(fetch).toHaveBeenCalledTimes(1);
    requests[0].resolve(1);
    await refresh;
    await tick(600);
    requests[1].resolve(0);
    await tick();
    expect(apply).toHaveBeenCalledExactlyOnceWith(0);
  });

  it.each(['computer change', 'client replacement', 'disconnect/reconnect'])(
    'ignores delayed old responses after %s, even when they finish last',
    async () => {
      const { scheduler, fetch, requests, apply } = setup();
      const old = scheduler.refresh();
      await tick();
      scheduler.schedule();
      scheduler.reset();
      const fresh = scheduler.refresh();
      await tick();
      requests[1].resolve(0);
      await fresh;
      requests[0].resolve(1);
      await old;
      await tick(6000);
      expect(apply).toHaveBeenCalledExactlyOnceWith(0);
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it('cancels a queued debounce on disconnect', async () => {
    const { scheduler, fetch } = setup();
    scheduler.schedule();
    scheduler.reset();
    await tick(6000);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not loop on failure, but permits a later event to refresh', async () => {
    const { scheduler, fetch, requests, apply } = setup();
    scheduler.schedule();
    await tick(600);
    requests[0].reject(new Error('offline'));
    await tick(6000);
    expect(fetch).toHaveBeenCalledTimes(1);
    scheduler.schedule();
    await tick(600);
    requests[1].resolve(0);
    await tick();
    expect(apply).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('retains one real invalidation after a failed in-flight request, without retrying that failure forever', async () => {
    const { scheduler, fetch, requests } = setup();
    scheduler.schedule();
    await tick(600);
    scheduler.schedule();
    requests[0].reject(new Error('first failure'));
    await tick(600);
    expect(fetch).toHaveBeenCalledTimes(2);
    requests[1].reject(new Error('second failure'));
    await tick(6000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
