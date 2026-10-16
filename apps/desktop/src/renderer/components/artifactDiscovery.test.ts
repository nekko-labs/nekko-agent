import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createArtifactDiscovery } from './artifactDiscovery.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function fixture() {
  let open = false;
  let highlighted = false;
  const discover = vi.fn(() => { open = true; });
  const status = vi.fn((active: boolean) => { highlighted = active; });
  const discovery = createArtifactDiscovery(discover, status);
  return { ...discovery, discover, status, get open() { return open; }, get highlighted() { return highlighted; }, collapse() { open = false; } };
}

describe('monitor artifact discovery', () => {
  it('hydrates existing paths silently, then discovers paths rather than count changes', () => {
    const f = fixture();
    f.update('s', ['/a.md', '/b.md']);
    expect(f.open).toBe(false);
    expect(f.highlighted).toBe(false);
    f.update('s', ['/a.md']);
    expect(f.discover).not.toHaveBeenCalled();
    f.update('s', ['/c.md']); // Same count, different path.
    expect(f.discover).toHaveBeenCalledTimes(1);
    expect(f.open).toBe(true);
    expect(f.highlighted).toBe(true);
    vi.advanceTimersByTime(10_000);
    expect(f.highlighted).toBe(false);
    expect(f.open).toBe(true); // Expiry never collapses.
  });

  it('does not retrigger for duplicate, case-changed, reordered or reappearing paths', () => {
    const f = fixture();
    f.update('s', []);
    f.update('s', ['/a.md', '/b.md']);
    vi.advanceTimersByTime(5_000);
    f.collapse();
    f.update('s', ['/B.md', '/a.md', '/a.md']);
    f.update('s', []);
    f.update('s', ['/a.md']);
    expect(f.discover).toHaveBeenCalledTimes(1);
    expect(f.open).toBe(false);
    vi.advanceTimersByTime(5_000);
    expect(f.highlighted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('respects manual collapse until a distinct path arrives and restarts the deadline', () => {
    const f = fixture();
    f.update('s', []);
    f.update('s', ['/a.md']);
    f.collapse();
    vi.advanceTimersByTime(9_000);
    f.update('s', ['/a.md', '/b.md']);
    expect(f.open).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1_000);
    expect(f.highlighted).toBe(true);
    vi.advanceTimersByTime(8_999);
    expect(f.highlighted).toBe(true);
    vi.advanceTimersByTime(1);
    expect(f.highlighted).toBe(false);
  });

  it('switches session baselines and cancels the previous timer', () => {
    const f = fixture();
    f.update('a', []);
    f.update('a', ['/new.md']);
    f.update('b', ['/history.md']);
    expect(f.highlighted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.discover).toHaveBeenCalledTimes(1);
    f.update('b', ['/history.md', '/new.md']);
    expect(f.discover).toHaveBeenCalledTimes(2);
    f.update('a', ['/new.md', '/other-history.md']);
    expect(f.discover).toHaveBeenCalledTimes(2);
  });

  it('treats null or missing-session hydration as unknown, not an empty baseline', () => {
    const f = fixture();
    f.update('s', null);
    f.update('s', null);
    f.update('s', ['/history.md']);
    expect(f.discover).not.toHaveBeenCalled();
    f.update('s', ['/new.md']);
    expect(f.highlighted).toBe(true);
    f.update('s', null);
    expect(f.highlighted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    f.update('s', ['/history.md', '/more-history.md']);
    expect(f.discover).toHaveBeenCalledTimes(1);
  });

  it('cleans up pending callbacks on unmount and can hydrate again after effect replay', () => {
    const f = fixture();
    f.update('s', []);
    f.update('s', ['/a.md']);
    f.dispose();
    expect(vi.getTimerCount()).toBe(0);
    f.status.mockClear();
    vi.advanceTimersByTime(20_000);
    expect(f.status).not.toHaveBeenCalled();
    f.update('s', ['/a.md', '/history.md']);
    expect(f.discover).toHaveBeenCalledTimes(1);
    expect(f.highlighted).toBe(false);
  });
});
