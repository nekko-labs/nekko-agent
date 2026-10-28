import { useSyncExternalStore } from 'react';
import { parseSimpleChoices, simpleShown, type SimpleChoices, type SimpleVisibility } from '@nekko-agent/shared';

/*
 * Simple and Expert (decision 0030, spec desktop/desktop-simple-and-expert-modes). Simple is
 * the everyday app: developer controls stay out of sight. Expert shows every
 * control. Settings > Simple mode chooses, per control, whether it shows in
 * both modes, in Expert only, or nowhere. Both are kept on this computer and
 * shared by every window; a new install starts in Simple.
 */

const MODE_KEY = 'nekko.chatMode';
const CHOICES_KEY = 'nekko.simpleChoices';
const modeListeners = new Set<() => void>();
const subscribe = (fn: () => void) => { modeListeners.add(fn); return () => { modeListeners.delete(fn); }; };
const notify = () => { for (const l of modeListeners) l(); };
const readExpert = () => {
  try { return window.localStorage.getItem(MODE_KEY) === 'expert'; } catch { return false; }
};
const readChoicesRaw = () => {
  try { return window.localStorage.getItem(CHOICES_KEY) ?? ''; } catch { return ''; }
};
// One parsed object per saved string, so useSyncExternalStore sees a stable value.
let choicesCache: { raw: string; value: SimpleChoices } = { raw: '', value: {} };
const readChoices = (): SimpleChoices => {
  const raw = readChoicesRaw();
  if (raw !== choicesCache.raw) choicesCache = { raw, value: parseSimpleChoices(raw) };
  return choicesCache.value;
};

/** Expert mode, saved on this machine and shared by every open chat. */
export function useExpertMode(): [boolean, (on: boolean) => void] {
  // Without a window (static rendering in tests) nothing is saved: show every control.
  const expert = useSyncExternalStore(subscribe, readExpert, () => true);
  const set = (on: boolean) => {
    try { window.localStorage.setItem(MODE_KEY, on ? 'expert' : 'simple'); } catch { /* best effort */ }
    notify();
  };
  return [expert, set];
}

/** The person's Settings > Simple mode choices, and a setter for one control. */
export function useSimpleChoices(): [SimpleChoices, (id: string, v: SimpleVisibility | null) => void] {
  const choices = useSyncExternalStore(subscribe, readChoices, () => choicesCache.value);
  const set = (id: string, v: SimpleVisibility | null) => {
    const next: Record<string, SimpleVisibility> = { ...readChoices() };
    if (v) next[id] = v; else delete next[id];
    try { window.localStorage.setItem(CHOICES_KEY, JSON.stringify(parseSimpleChoices(next))); } catch { /* best effort */ }
    notify();
  };
  return [choices, set];
}

/** Whether a listed control is on screen now, read once (for menus that mount when opened). */
export function shownNow(id: string): boolean {
  return typeof window === 'undefined' || simpleShown(id, readExpert(), readChoices(), localLoaded);
}

// Whether the Model Server holds a local model: monitors then show in Simple
// too. Read every 10 s, only while something on screen is listening.
const localListeners = new Set<() => void>();
let localLoaded = false;
let localTimer: ReturnType<typeof setInterval> | undefined;
const readLocal = () => {
  window.nekko?.engineStatus?.()
    .then((s) => {
      const next = !!s?.running && (s.resident?.length ?? 0) > 0;
      if (next !== localLoaded) { localLoaded = next; for (const l of localListeners) l(); }
    })
    .catch(() => {});
};
const subscribeLocal = (fn: () => void) => {
  localListeners.add(fn);
  if (!localTimer) { readLocal(); localTimer = setInterval(readLocal, 10_000); }
  return () => {
    localListeners.delete(fn);
    if (localListeners.size === 0 && localTimer) { clearInterval(localTimer); localTimer = undefined; }
  };
};

/** Whether a local model is loaded on the Model Server. */
export function useLocalModelLoaded(): boolean {
  return useSyncExternalStore(subscribeLocal, () => localLoaded, () => false);
}

/** Whether a listed control is on screen now, in the current mode. */
export function useShown(id: string): boolean {
  const [expert] = useExpertMode();
  const [choices] = useSimpleChoices();
  const local = useLocalModelLoaded();
  return simpleShown(id, expert, choices, local);
}
