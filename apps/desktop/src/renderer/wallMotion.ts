import type { Direction } from './layout.js';

/**
 * Opening and closing a wall window is one push. The windows beside it slide
 * to their new place on a transform (slideWindow: their left/top jump, and a
 * translate from the old place runs off), and the window itself is
 * revealed from, or folded into, the edge on its far side over the same time
 * and curve, so its moving edge rides the seam with its neighbours. A closing
 * window leaves stardust along the edge it folded into, as a completed row in
 * the Agents panel does.
 */
export const WALL_PUSH_MS = 220;
/** A strong ease-out with no overshoot. Keep in step with --wall-push-ease in commandWallLayouts.css. */
export const WALL_PUSH_EASE = 'cubic-bezier(.23, 1, .32, 1)';
/** The stardust outlives the fold; it never blocks input. */
export const EDGE_DUST_MS = 900;

export interface Box { x: number; y: number; width: number; height: number }

const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
const area = (a: Box, b: Box) => overlap(a.x, a.x + a.width, b.x, b.x + b.width) * overlap(a.y, a.y + a.height, b.y, b.y + b.height);

/**
 * Of `candidates`, the window whose box covers most of `box`: the one that
 * gave up its room to a new window, or takes over the room a closing one left.
 */
export function mostOverlapping(box: Box, candidates: Iterable<[string, Box]>): string | null {
  let best: string | null = null;
  let most = 0;
  for (const [id, other] of candidates) {
    const a = area(box, other);
    if (a > most) { most = a; best = id; }
  }
  return best;
}

/**
 * The side of `box` facing away from its neighbour `from` (both in their
 * side-by-side positions): the edge a new window opens out of, and the edge a
 * closing one folds into. Left when there is no neighbour to push.
 */
export function outerSide(box: Box, from: Box | undefined): Direction {
  if (!from) return 'left';
  const sharedRows = overlap(box.y, box.y + box.height, from.y, from.y + from.height);
  const sharedCols = overlap(box.x, box.x + box.width, from.x, from.x + from.width);
  const dx = box.x + box.width / 2 - (from.x + from.width / 2);
  const dy = box.y + box.height / 2 - (from.y + from.height / 2);
  // Side by side share rows; stacked share columns.
  if (sharedRows > sharedCols || (sharedRows === sharedCols && Math.abs(dx) >= Math.abs(dy))) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'down' : 'up';
}

/** The clip that shows nothing but the `side` edge of a window. */
export function edgeClip(side: Direction, radius: string): string {
  const inset = side === 'right' ? '0 0 0 100%' : side === 'left' ? '0 100% 0 0' : side === 'down' ? '100% 0 0 0' : '0 0 100% 0';
  return `inset(${inset} round ${radius})`;
}

const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * A window whose box moved from `from` to where it is now slides there on a
 * composited transform rather than a left/top transition (which lays the
 * whole wall out every frame). Interruptible: a slide still running is
 * measured where it is and the new one starts from there.
 */
export function slideWindow(el: HTMLElement, from: Pick<Box, 'x' | 'y'>, to: Pick<Box, 'x' | 'y'>): Animation | null {
  if (reducedMotion() || typeof el.animate !== 'function') return null;
  let dx = from.x - to.x;
  let dy = from.y - to.y;
  const running = slides.get(el);
  if (running) {
    const m = new DOMMatrixReadOnly(getComputedStyle(el).transform === 'none' ? undefined : getComputedStyle(el).transform);
    dx += m.m41; dy += m.m42;
    running.cancel();
  }
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) { slides.delete(el); return null; }
  const slide = el.animate(
    [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
    { duration: WALL_PUSH_MS, easing: WALL_PUSH_EASE },
  );
  slides.set(el, slide);
  const done = () => { if (slides.get(el) === slide) slides.delete(el); };
  slide.finished.then(done, done);
  return slide;
}
const slides = new WeakMap<HTMLElement, Animation>();

/** A window that just joined the wall opens out of its `side` edge. */
export function growWindow(el: HTMLElement, side: Direction): Animation | null {
  if (reducedMotion() || typeof el.animate !== 'function') return null;
  const radius = getComputedStyle(el).borderRadius || '0px';
  return el.animate(
    [{ clipPath: edgeClip(side, radius), opacity: 0.7 }, { clipPath: `inset(0 0 0 0 round ${radius})`, opacity: 1 }],
    { duration: WALL_PUSH_MS, easing: WALL_PUSH_EASE },
  );
}

/**
 * A window React has just taken off the wall, put back as an inert picture of
 * itself in `layer`, folded into its `side` edge, then dropped. Live embeds
 * are taken out first: a re-attached webview would load its page again.
 */
export function foldWindow(el: HTMLElement, layer: HTMLElement, side: Direction): void {
  if (reducedMotion() || el.isConnected || typeof el.animate !== 'function') return;
  el.querySelectorAll('webview, iframe, video, audio').forEach((n) => n.remove());
  for (const attr of ['data-wall-pane', 'data-grid-cell', 'data-wall-selected']) el.removeAttribute(attr);
  el.querySelectorAll('[data-shortcut-pane]').forEach((n) => n.removeAttribute('data-shortcut-pane'));
  el.setAttribute('data-wall-leaving', '');
  el.setAttribute('aria-hidden', 'true');
  el.inert = true;
  layer.append(el);
  const radius = getComputedStyle(el).borderRadius || '0px';
  const fold = el.animate(
    [{ clipPath: `inset(0 0 0 0 round ${radius})`, opacity: 1 }, { clipPath: edgeClip(side, radius), opacity: 0.6 }],
    { duration: WALL_PUSH_MS, easing: WALL_PUSH_EASE, fill: 'forwards' },
  );
  // Dust as the fold lands, where it lands.
  const rect = el.getBoundingClientRect();
  const dust = window.setTimeout(() => scatterEdgeDust(rect, side), Math.round(WALL_PUSH_MS * 0.6));
  const drop = () => { window.clearTimeout(dust); el.remove(); };
  // A hidden window paints no frames; never leave the picture behind.
  void Promise.race([fold.finished, new Promise((r) => window.setTimeout(r, WALL_PUSH_MS + 50))]).then(drop, drop);
}

/**
 * The completed row's stardust, laid along one edge of a box and drifting out
 * past it. Lives on the body, so it outlasts the window it came from.
 */
export function scatterEdgeDust(rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>, side: Direction): void {
  const vertical = side === 'left' || side === 'right';
  const length = vertical ? rect.height : rect.width;
  if (length <= 0) return;
  const out = side === 'right' || side === 'down' ? 1 : -1;
  const dust = document.createElement('div');
  dust.className = 'completion-stardust';
  dust.setAttribute('aria-hidden', 'true');
  dust.style.left = `${side === 'right' ? rect.left + rect.width : side === 'left' ? rect.left : rect.left + rect.width / 2}px`;
  dust.style.top = `${side === 'down' ? rect.top + rect.height : side === 'up' ? rect.top : rect.top + rect.height / 2}px`;
  const grains = Math.max(10, Math.min(22, Math.round(length / 28)));
  for (let i = 0; i < grains; i += 1) {
    const grain = document.createElement('i');
    // Spread along the edge (a little short of its corners), then drift out.
    const along = ((i + Math.random()) / grains - 0.5) * length * 0.9;
    const drift = out * (10 + Math.random() * 26);
    const sway = (Math.random() - 0.5) * 16;
    const [x0, y0, x, y] = vertical ? [out * -3, along, drift, along + sway] : [along, out * -3, along + sway, drift];
    grain.style.setProperty('--dust-x0', `${x0.toFixed(1)}px`);
    grain.style.setProperty('--dust-y0', `${y0.toFixed(1)}px`);
    // The first step out of the edge: sideways off a left or right edge.
    grain.style.setProperty('--dust-step-x', vertical ? `${out * 4}px` : '0px');
    grain.style.setProperty('--dust-x', `${x.toFixed(1)}px`);
    grain.style.setProperty('--dust-y', `${y.toFixed(1)}px`);
    grain.style.setProperty('--dust-size', `${(2 + Math.random() * 3).toFixed(1)}px`);
    grain.style.setProperty('--dust-delay', `${Math.round(Math.random() * 160)}ms`);
    if (i % 4 === 0) grain.className = 'is-star';
    dust.append(grain);
  }
  document.body.append(dust);
  window.setTimeout(() => dust.remove(), EDGE_DUST_MS);
}
