/**
 * Ctrl/⌘ + Plus or Minus, and Ctrl/⌘ + scroll wheel, step Settings' text size
 * (`textScale`) up or down, and Ctrl/⌘+0 puts it back to 100%. They move the same setting Style shows, so there is still only one scale.
 */
import { saveSettings } from './settingsIndex.js';
import { SHORTCUTS } from './shortcuts.js';
import { textScaleOf, useStore } from './store.js';
import { stepTextScale } from './textScale.js';

/** Wheel travel, in pixels, for one step: about half a mouse notch, so each notch is one step and a trackpad pinch needs a deliberate move. */
export const WHEEL_STEP = 50;
/** A pause this long ends a wheel gesture, so leftover travel does not carry into the next one. */
const WHEEL_IDLE_MS = 300;
/** Quick steps are saved once, after the last. */
const SAVE_DELAY_MS = 300;

let saveTimer: ReturnType<typeof setTimeout> | undefined;

/** Step the app's text size, applying it at once and saving it shortly after. Returns the new size, or null at a limit or before settings load. */
export const stepAppTextScale = (direction: 1 | -1): number | null =>
  setAppTextScale((from) => stepTextScale(from, direction));

/** Back to 100%, the same way. */
export const resetAppTextScale = (): number | null => setAppTextScale(() => 100);

function setAppTextScale(next: (from: number) => number): number | null {
  const { settings } = useStore.getState();
  if (!settings) return null;
  const from = textScaleOf(settings.textScale);
  const to = next(from);
  if (to === from) return null;
  useStore.setState({ settings: { ...settings, textScale: to } });
  useStore.getState().applyTheme();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void saveSettings({ textScale: textScaleOf(useStore.getState().settings?.textScale) }), SAVE_DELAY_MS);
  return to;
}

/** Turns wheel travel into steps: up (negative deltaY) is bigger. Reversing direction starts over. */
export function wheelStepper(step: (direction: 1 | -1) => void, now: () => number = Date.now) {
  let travel = 0;
  let last = 0;
  return (deltaY: number) => {
    const t = now();
    if (t - last > WHEEL_IDLE_MS || Math.sign(deltaY) !== Math.sign(travel)) travel = 0;
    last = t;
    travel += deltaY;
    while (Math.abs(travel) >= WHEEL_STEP) {
      step(travel < 0 ? 1 : -1);
      travel -= Math.sign(travel) * WHEEL_STEP;
    }
  };
}

/** Listen for the keys and the wheel app-wide. Returns the cleanup. */
export function startTextZoom(): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    if (SHORTCUTS.textReset.matches(e)) {
      e.preventDefault();
      resetAppTextScale();
      return;
    }
    const direction = SHORTCUTS.textBigger.matches(e) ? 1 : SHORTCUTS.textSmaller.matches(e) ? -1 : 0;
    if (!direction) return;
    e.preventDefault();
    stepAppTextScale(direction);
  };
  const wheel = wheelStepper((direction) => stepAppTextScale(direction));
  const onWheel = (e: WheelEvent) => {
    // Something that zooms itself (a full-window diagram) has already taken it.
    if (!(e.ctrlKey || e.metaKey) || e.defaultPrevented) return;
    // Also stops Chromium's own Ctrl+wheel zoom.
    e.preventDefault();
    wheel(e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * 40 : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? e.deltaY * 800 : e.deltaY);
  };
  window.addEventListener('keydown', onKey);
  window.addEventListener('wheel', onWheel, { passive: false });
  return () => {
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('wheel', onWheel);
  };
}
