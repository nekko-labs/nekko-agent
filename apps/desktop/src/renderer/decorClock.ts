/**
 * The looping decorations (a working agent's beam and rocket, the pixel cat,
 * the needs-you glow, the pulsing dots) animate what the compositor cannot run
 * by itself: a gradient's angle, SVG paths, colours, a shadow. Chromium ticks
 * such an animation on the main thread every frame, stepped or not, so while
 * an agent worked the page never went idle: a style pass (often a repaint) on
 * every frame at the display's rate, and every key and click queued behind a
 * decoration's frame. Measured on the speed contract, these alone added a
 * third to the composer's keypress latency while a reply streamed.
 *
 * Their steps are 15 fps or slower, so this clock pauses them and moves them
 * on itself, `DECOR_HZ` times a second: the same frames, drawn at the same
 * moments to within a tick, and an idle main thread in between. While the
 * window is hidden or unfocused (appActivity.ts) the clock stops, and they
 * hold their frame as before.
 */

/** The decorations' keyframe names (styles.css; `pulse` is Tailwind's animate-pulse). */
export const DECOR_ANIMATIONS: ReadonlySet<string> = new Set([
  'composer-beam-spin',
  'rocket-breathe', 'rocket-hover', 'rocket-flame', 'rocket-streak',
  'pixel-hop', 'pixel-open', 'pixel-happy', 'pixel-blink',
  'pixel-quiet-hop', 'pixel-quiet-open', 'pixel-quiet-blink',
  'wall-needs-you-pulse',
  'pulse',
]);

/** Twice the fastest decoration's step rate (the beam's 15 fps). */
export const DECOR_HZ = 30;

/** The slice of a CSS animation the clock drives. */
export interface DecorAnimation {
  readonly animationName?: string;
  readonly playState: string;
  readonly startTime: number | null | CSSNumberish;
  currentTime: number | null | CSSNumberish;
  readonly effect: { readonly target?: Element | null } | null;
  pause(): void;
}

interface DecorDocument {
  readonly hidden: boolean;
  readonly documentElement: { hasAttribute(name: string): boolean };
  readonly timeline: { readonly currentTime: number | null | CSSNumberish };
  getAnimations(): DecorAnimation[];
  addEventListener(type: 'animationstart', fn: (e: { animationName: string; target: EventTarget | null }) => void, capture: boolean): void;
  removeEventListener(type: 'animationstart', fn: (e: { animationName: string; target: EventTarget | null }) => void, capture: boolean): void;
}

interface Timers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
}

const isDecor = (a: DecorAnimation): boolean => !!a.animationName && DECOR_ANIMATIONS.has(a.animationName);

/** Start the clock; returns a stop function that hands every decoration back to the browser. */
export function startDecorClock(doc: DecorDocument = document as unknown as DecorDocument, timers: Timers = window as unknown as Timers): () => void {
  const held = new Map<DecorAnimation, number>();
  let timer: unknown = null;
  const now = () => Number(doc.timeline.currentTime ?? 0);

  const tick = () => {
    if (doc.hidden || doc.documentElement.hasAttribute('data-app-inactive')) return;
    const t = now();
    for (const [a, start] of held) {
      if (a.playState === 'idle' || !a.effect?.target?.isConnected) { held.delete(a); continue; }
      a.currentTime = t - start;
    }
    if (!held.size && timer !== null) { timers.clearInterval(timer); timer = null; }
  };
  const hold = (a: DecorAnimation) => {
    if (held.has(a) || a.playState === 'idle' || !isDecor(a)) return;
    const start = a.startTime == null ? now() - Number(a.currentTime ?? 0) : Number(a.startTime);
    a.pause();
    held.set(a, start);
    if (timer === null) timer = timers.setInterval(tick, 1000 / DECOR_HZ);
  };
  const onStart = (e: { animationName: string; target: EventTarget | null }) => {
    if (!DECOR_ANIMATIONS.has(e.animationName)) return;
    const el = e.target as Element | null;
    for (const a of (el?.getAnimations?.({ subtree: true }) ?? []) as unknown as DecorAnimation[]) {
      if (a.animationName === e.animationName) hold(a);
    }
  };

  for (const a of doc.getAnimations()) hold(a);
  doc.addEventListener('animationstart', onStart, true);
  return () => {
    doc.removeEventListener('animationstart', onStart, true);
    if (timer !== null) timers.clearInterval(timer);
    timer = null;
    // Back to the browser's own clock, where each one already is.
    for (const a of held.keys()) (a as unknown as { play?: () => void }).play?.();
    held.clear();
  };
}
