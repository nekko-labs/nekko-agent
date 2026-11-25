/** How often a visible card re-reads a running terminal's tail. */
export const EXCERPT_POLL_MS = 3000;

/**
 * Reads a terminal's tail for a card, only while it is worth it: the card on
 * screen, the window shown and the terminal running. `read` resolves true once
 * the terminal ended (that read is its last), and `onExit` is told when the
 * terminal exits (a final read follows). A card scrolled away or hidden, and
 * a terminal that ended, make no requests; coming back reads at once.
 */
export function startExcerptPoll(opts: {
  read: () => Promise<boolean>;
  element: Element | null;
  onExit?: (exited: () => void) => (() => void) | undefined;
}): () => void {
  let disposed = false, onScreen = true, ended = false, busy = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const polling = () => !ended && onScreen && !document.hidden;
  const schedule = () => {
    if (polling() && !timer) timer = setInterval(read, EXCERPT_POLL_MS);
    else if (!polling() && timer) { clearInterval(timer); timer = undefined; }
  };
  function read() {
    if (busy || disposed) return;
    busy = true;
    opts.read().then((last) => { if (last) { ended = true; schedule(); } }, () => {}).finally(() => { busy = false; });
  }
  const refocus = () => { if (polling()) read(); schedule(); };
  read();
  schedule();
  const observer = typeof IntersectionObserver === 'function' && opts.element
    ? new IntersectionObserver((entries) => { onScreen = entries[entries.length - 1]?.isIntersecting ?? true; refocus(); })
    : null;
  if (observer && opts.element) observer.observe(opts.element);
  document.addEventListener('visibilitychange', refocus);
  const off = opts.onExit?.(() => { ended = true; busy = false; read(); schedule(); });
  return () => {
    disposed = true;
    if (timer) clearInterval(timer);
    observer?.disconnect();
    document.removeEventListener('visibilitychange', refocus);
    off?.();
  };
}
