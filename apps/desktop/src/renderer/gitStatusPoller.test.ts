import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { GitStatus } from '@nekko-agent/shared';
import { GIT_POLL_MS, lastGitStatus, subscribeGitStatus } from './gitStatusPoller.js';

const repo = (branch: string) => ({ repo: true, branch }) as unknown as GitStatus;

let doc: EventTarget & { hidden: boolean };
let push: ((e: { path: string }) => void) | undefined;
let getGitStatus: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  doc = Object.assign(new EventTarget(), { hidden: false });
  vi.stubGlobal('document', doc);
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
  getGitStatus = vi.fn(async () => repo('main'));
  push = undefined;
  vi.stubGlobal('window', { nekko: { getGitStatus, onGitChanged: (cb: (e: { path: string }) => void) => { push = cb; return () => { push = undefined; }; } } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('shares one poll per key between every card that shows it', async () => {
  const a = vi.fn(), b = vi.fn();
  const offA = subscribeGitStatus('session:s1', a);
  await vi.advanceTimersByTimeAsync(10);
  expect(getGitStatus).toHaveBeenCalledTimes(1);
  expect(a).toHaveBeenCalledWith(repo('main'));
  // A second card gets the last read at once and costs no request.
  const offB = subscribeGitStatus('session:s1', b);
  expect(b).toHaveBeenCalledWith(repo('main'));
  expect(lastGitStatus('session:s1')).toEqual(repo('main'));
  await vi.advanceTimersByTimeAsync(GIT_POLL_MS);
  expect(getGitStatus).toHaveBeenCalledTimes(2);
  expect(a).toHaveBeenCalledTimes(2);
  expect(b).toHaveBeenCalledTimes(2);
  // Another key has its own.
  const offC = subscribeGitStatus('folder-1', vi.fn());
  await vi.advanceTimersByTimeAsync(10);
  expect(getGitStatus).toHaveBeenCalledTimes(3);
  offA(); offB(); offC();
  await vi.advanceTimersByTimeAsync(GIT_POLL_MS * 3);
  expect(getGitStatus).toHaveBeenCalledTimes(3);
  expect(push).toBeUndefined();
});

it('re-reads at once, once, when the daemon says git changed', async () => {
  const l = vi.fn();
  const off = subscribeGitStatus('session:s1', l);
  const other = subscribeGitStatus('session:s2', vi.fn());
  await vi.advanceTimersByTimeAsync(10);
  expect(getGitStatus).toHaveBeenCalledTimes(2);
  getGitStatus.mockImplementation(async () => repo('feature'));
  push!({ path: '/w' }); push!({ path: '/w' }); push!({ path: '/w/other' });
  await vi.advanceTimersByTimeAsync(400);
  expect(getGitStatus).toHaveBeenCalledTimes(4);
  expect(l).toHaveBeenLastCalledWith(repo('feature'));
  off(); other();
});

it('makes no read while hidden, reads on return, and never overlaps a slow read', async () => {
  let finish!: () => void;
  getGitStatus.mockImplementation(() => new Promise((resolve) => { finish = () => resolve(repo('main')); }));
  const off = subscribeGitStatus('session:s1', vi.fn());
  await vi.advanceTimersByTimeAsync(GIT_POLL_MS * 2);
  expect(getGitStatus).toHaveBeenCalledTimes(1);
  finish(); await vi.advanceTimersByTimeAsync(0);
  doc.hidden = true;
  await vi.advanceTimersByTimeAsync(GIT_POLL_MS * 3);
  expect(getGitStatus).toHaveBeenCalledTimes(1);
  doc.hidden = false; doc.dispatchEvent(new Event('visibilitychange'));
  expect(getGitStatus).toHaveBeenCalledTimes(2);
  finish();
  off();
});

it('reports a folder that is not a repository, or a failed read, as null', async () => {
  getGitStatus.mockImplementationOnce(async () => ({ repo: false }) as unknown as GitStatus).mockRejectedValueOnce(new Error('x'));
  const l = vi.fn();
  const off = subscribeGitStatus('folder-1', l);
  await vi.advanceTimersByTimeAsync(10);
  expect(l).toHaveBeenLastCalledWith(null);
  await vi.advanceTimersByTimeAsync(GIT_POLL_MS);
  expect(l).toHaveBeenCalledTimes(2);
  expect(l).toHaveBeenLastCalledWith(null);
  off();
});
