/** Toasts on screen at once; a newer one pushes the oldest out. */
export const MAX_TOASTS = 3;
/** How long an info or success toast stays. Errors stay until dismissed. */
export const TOAST_MS = 5000;
/** The exit animation's length (`.toast-item[data-leaving]` in styles.css). */
export const TOAST_EXIT_MS = 160;

interface QueuedToast {
  id: string;
  kind: 'info' | 'error' | 'success';
  leaving?: boolean;
}

/** Errors are sticky: they wait for the reader instead of timing out. */
export function autoDismisses(kind: QueuedToast['kind']): boolean {
  return kind !== 'error';
}

/**
 * Which toasts to dismiss so at most `max` remain, given the list with the
 * newest last. The newest always stays. Older infos and successes go first,
 * oldest first, so a sticky error outlives chatter that arrived after it; only
 * a pile of errors pushes an error out. Toasts already leaving do not count.
 */
export function overflowToasts(toasts: readonly QueuedToast[], max = MAX_TOASTS): string[] {
  const live = toasts.filter((t) => !t.leaving);
  const extra = live.length - max;
  if (extra <= 0) return [];
  const older = live.slice(0, -1);
  const order = [...older.filter((t) => t.kind !== 'error'), ...older.filter((t) => t.kind === 'error')];
  return order.slice(0, extra).map((t) => t.id);
}
