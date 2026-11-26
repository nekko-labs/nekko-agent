import { afterEach, expect, it, vi } from 'vitest';
import { EXCERPT_POLL_MS, startExcerptPoll } from './terminalExcerptPoll.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function setup() {
  vi.useFakeTimers();
  const doc = Object.assign(new EventTarget(), { hidden: false });
  vi.stubGlobal('document', doc);
  let visible!: (entries: { isIntersecting: boolean }[]) => void;
  vi.stubGlobal('IntersectionObserver', class { constructor(cb: typeof visible) { visible = cb; } observe() {} disconnect() {} });
  return { doc, scroll: (isIntersecting: boolean) => visible([{ isIntersecting }]) };
}

it('reads at once, then every few seconds while on screen, shown and running', async () => {
  const { doc } = setup();
  const read = vi.fn(async () => false);
  const stop = startExcerptPoll({ read, element: {} as Element });
  expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(EXCERPT_POLL_MS * 3);
  expect(read).toHaveBeenCalledTimes(4);
  stop();
  await vi.advanceTimersByTimeAsync(EXCERPT_POLL_MS * 3);
  expect(read).toHaveBeenCalledTimes(4);
  void doc;
});

it('makes no request while the card is off screen or the window hidden, and reads again on return', async () => {
  const { doc, scroll } = setup();
  const read = vi.fn(async () => false);
  const stop = startExcerptPoll({ read, element: {} as Element });
  await vi.advanceTimersByTimeAsync(0);
  scroll(false);
  await vi.advanceTimersByTimeAsync(EXCERPT_POLL_MS * 5);
  expect(read).toHaveBeenCalledTimes(1);
  scroll(true);
  expect(read).toHaveBeenCalledTimes(2);
  doc.hidden = true; doc.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(EXCERPT_POLL_MS * 5);
  expect(read).toHaveBeenCalledTimes(2);
  doc.hidden = false; doc.dispatchEvent(new Event('visibilitychange'));
  expect(read).toHaveBeenCalledTimes(3);
  stop();
});

it('stops after the read that finds the terminal ended, and reads once more when it exits', async () => {
  setup();
  let ended = false;
  const read = vi.fn(async () => ended);
  let exited!: () => void;
  const stop = startExcerptPoll({ read, element: {} as Element, onExit: (cb) => { exited = cb; return () => {}; } });
  await vi.advanceTimersByTimeAsync(EXCERPT_POLL_MS);
  expect(read).toHaveBeenCalledTimes(2);
  ended = true;
  exited();
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(EXCERPT_POLL_MS * 5);
  expect(read).toHaveBeenCalledTimes(3);
  stop();
});

it('does not overlap a slow read with the next tick', async () => {
  setup();
  let finish!: () => void;
  const read = vi.fn(() => new Promise<boolean>((resolve) => { finish = () => resolve(false); }));
  const stop = startExcerptPoll({ read, element: {} as Element });
  await vi.advanceTimersByTimeAsync(EXCERPT_POLL_MS * 3);
  expect(read).toHaveBeenCalledTimes(1);
  finish(); await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(EXCERPT_POLL_MS);
  expect(read).toHaveBeenCalledTimes(2);
  stop();
});
