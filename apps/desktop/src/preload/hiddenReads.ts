/**
 * A read the page polls (`engine:status`, `gpu:stats`) that costs the machine
 * something each time: an `nvidia-smi` run, a runtime search. While the page is
 * hidden (minimized, closed to the tray, or covered by a full-screen game,
 * which Chromium reports as hidden too) nobody sees the answer, so the last
 * one stands rather than asking again. Back on screen, the next poll asks.
 */
export function heldWhileHidden<T>(read: () => Promise<T>, hidden: () => boolean): () => Promise<T> {
  let last: { value: T } | null = null;
  return async () => {
    if (last && hidden()) return last.value;
    const value = await read();
    last = { value };
    return value;
  };
}

/** `document.hidden`, false where there is no document. */
export const pageHidden = (): boolean => typeof document !== 'undefined' && document.hidden === true;
