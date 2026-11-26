import { useEffect, type RefObject } from 'react';

/**
 * Holds the animations of a parked pane and lets them run again when it is shown.
 *
 * The workspace keeps recently used chats mounted, parked under the one on
 * screen, so a decoration looping inside one (the mascot, a pixel spinner)
 * would keep costing frames nobody sees (#3407). A stylesheet rule keyed on the
 * pane's `data-pane-hidden` attribute held them first, but that attribute flips
 * on every chat switch, and a rule matching every descendant made the browser
 * restyle the whole transcript of both panes inside the switch: the warm switch
 * went from about 12 ms to 25 ms at p50 (#712). Pausing the animations that are
 * actually running, through the Web Animations API and after the switch has
 * painted, costs a short list and no restyle.
 *
 * An animation that starts while the pane is parked runs until it is parked
 * again; a parked chat stops repainting its live turn, so that is rare. The
 * decor clock skips parked panes on its own (decorClock.ts).
 */
export function useParkedAnimations(ref: RefObject<HTMLElement | null>, shown: boolean): void {
  useEffect(() => {
    const el = ref.current;
    if (shown || !el || typeof el.getAnimations !== 'function') return;
    let held: Animation[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    // After the next frame, so parking never adds style work to the switch itself.
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() => {
        held = el.getAnimations({ subtree: true }).filter((a) => a.playState === 'running');
        for (const a of held) a.pause();
      }, 0);
    });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      // Only what this hook paused: a decoration the decor clock holds stays with it.
      for (const a of held) if (a.playState === 'paused') a.play();
    };
  }, [ref, shown]);
}
