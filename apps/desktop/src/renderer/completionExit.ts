import { EASE_OUT } from './easing.js';

/** The row folds shut toward its left edge. */
export const ROW_CLOSE_MS = 260;
/** Then the space it held closes, sliding the rows below it up. */
export const ROW_COLLAPSE_MS = 220;
/** The stardust lingers a little past the collapse; it never blocks input. */
export const STARDUST_MS = 900;
const STARDUST_GRAINS = 14;

/** Rows tagged with this attribute (holding the chat id) get the exit. */
export const COMPLETION_ROW_ATTR = 'data-completion-row';

export function findCompletionRow(sessionId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[${COMPLETION_ROW_ATTR}="${CSS.escape(sessionId)}"]`);
}

/**
 * Plays the completion exit on a sidebar row, then runs `complete`, which
 * removes the row from the list once the engine has saved the completion.
 * The row closes to the left, stardust drifts out of where it vanished, and
 * its height collapses so the rows below slide up into its place. If
 * `complete` reports failure the row is put back as it was.
 */
export async function completeWithExit(row: HTMLElement | null, complete: () => Promise<boolean>): Promise<void> {
  if (!row || row.dataset.completing || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    if (!row?.dataset.completing) await complete();
    return;
  }
  row.dataset.completing = 'true';
  row.style.pointerEvents = 'none';
  const rect = row.getBoundingClientRect();
  const computed = getComputedStyle(row);

  const close = row.animate(
    [
      { clipPath: 'inset(0 0 0 0 round 8px)', opacity: 1 },
      { clipPath: 'inset(0 100% 0 0 round 8px)', opacity: 0.6 },
    ],
    { duration: ROW_CLOSE_MS, easing: EASE_OUT, fill: 'forwards' },
  );
  await settled(close, ROW_CLOSE_MS);
  scatterStardust(rect);

  const collapse = row.animate(
    [
      { height: `${rect.height}px`, marginTop: computed.marginTop, marginBottom: computed.marginBottom, overflow: 'hidden' },
      { height: '0px', marginTop: '0px', marginBottom: '0px', overflow: 'hidden' },
    ],
    { duration: ROW_COLLAPSE_MS, delay: 60, easing: EASE_OUT, fill: 'forwards' },
  );
  await settled(collapse, ROW_COLLAPSE_MS + 60);

  let done = false;
  try {
    done = await complete();
  } finally {
    // Completed rows are unmounted by now; a failed one comes back.
    if (!done) {
      close.cancel();
      collapse.cancel();
      row.style.pointerEvents = '';
      delete row.dataset.completing;
    }
  }
}

/**
 * An animation's end, or its scheduled end if the page stops painting (a
 * hidden window gets no frames), so completing a chat never hangs on it.
 */
function settled(animation: Animation, ms: number): Promise<unknown> {
  return Promise.race([animation.finished, new Promise((resolve) => window.setTimeout(resolve, ms + 50))]);
}

/**
 * Fine glittering grains left behind at the point the row folded into,
 * trailing back along the line it travelled. Lives on the body so it
 * outlasts the row it came from.
 */
export function scatterStardust(rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>): void {
  const dust = document.createElement('div');
  dust.className = 'completion-stardust';
  dust.setAttribute('aria-hidden', 'true');
  dust.style.left = `${rect.left + 6}px`;
  dust.style.top = `${rect.top + rect.height / 2}px`;
  const reach = Math.min(rect.width * 0.6, 140);
  for (let i = 0; i < STARDUST_GRAINS; i += 1) {
    const grain = document.createElement('i');
    const t = i / (STARDUST_GRAINS - 1);
    // Spread along the row's path, thinning out the further they get.
    grain.style.setProperty('--dust-x0', `${(t * reach * 0.35).toFixed(1)}px`);
    grain.style.setProperty('--dust-x', `${(t * reach + 8 + Math.random() * 18).toFixed(1)}px`);
    grain.style.setProperty('--dust-y', `${((Math.random() - 0.5) * rect.height * 1.1).toFixed(1)}px`);
    grain.style.setProperty('--dust-size', `${(2 + Math.random() * 3).toFixed(1)}px`);
    grain.style.setProperty('--dust-delay', `${Math.round(t * 140 + Math.random() * 60)}ms`);
    if (i % 4 === 0) grain.className = 'is-star';
    dust.append(grain);
  }
  document.body.append(dust);
  window.setTimeout(() => dust.remove(), STARDUST_MS);
}
