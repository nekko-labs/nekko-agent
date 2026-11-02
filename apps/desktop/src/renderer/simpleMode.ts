import { useSyncExternalStore } from 'react';
import { useStore } from './store.js';
import { localModelHost, localModelRunning, parseSimpleChoices, simpleShown, type SimpleChoices, type SimpleContext, type SimpleVisibility } from '@nekko-agent/shared';

/*
 * Simple and Expert (decision 0041, spec desktop/desktop-simple-and-expert-modes). Simple is
 * the cleaner, more focused view; Expert shows every control. In both, a
 * control that means nothing right now stays out of sight. Settings > Simple
 * mode chooses where each control shows. Both are kept on this computer and
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
export function shownNow(id: string, context?: SimpleContext): boolean {
  return typeof window === 'undefined' || simpleShown(id, readExpert(), readChoices(), { localModel: localLoaded, ...context });
}

// Whether a local model is running here or on a connected computer: monitors
// show only then, unless pinned. Read every 10 s, only while something on
// screen is listening.
const localListeners = new Set<() => void>();
let localLoaded = false;
/** The connected computer the hardware monitor follows; null reads this one. */
let localHost: { id: string; name: string; loaded: number } | null = null;
let localTimer: ReturnType<typeof setInterval> | undefined;
const readLocal = () => {
  const linked = (useStore.getState?.().computers ?? []).filter((c) => c.state === 'online' && c.read);
  void Promise.all([
    window.nekko?.engineStatus?.().catch(() => null),
    // Read off over there, or a link that drops, simply counts as no model.
    ...linked.map((c) => window.nekko.computerEngineStatus(c.id).catch(() => null)),
  ]).then(([here, ...connected]) => {
    const next = localModelRunning(here, connected);
    const at = localModelHost(here, connected);
    const host = typeof at === 'number'
      ? { id: linked[at].id, name: linked[at].name, loaded: connected[at]?.resident?.length ?? 0 }
      : null;
    const moved = host?.id !== localHost?.id || host?.loaded !== localHost?.loaded;
    if (moved) localHost = host;
    if (next !== localLoaded || moved) { localLoaded = next; for (const l of localListeners) l(); }
  });
};
const subscribeLocal = (fn: () => void) => {
  localListeners.add(fn);
  if (!localTimer) { readLocal(); localTimer = setInterval(readLocal, 10_000); }
  return () => {
    localListeners.delete(fn);
    if (localListeners.size === 0 && localTimer) { clearInterval(localTimer); localTimer = undefined; }
  };
};

/** Whether a local model is running on this computer or a connected one. */
export function useLocalModelLoaded(): boolean {
  return useSyncExternalStore(subscribeLocal, () => localLoaded, () => false);
}

/** The connected computer a model runs on, when none runs here. */
export function useLocalModelHost() {
  return useSyncExternalStore(subscribeLocal, () => localHost, () => null);
}

/** Whether a listed control is on screen now, in the current mode. `context` says what is true of this chat. */
export function useShown(id: string, context?: SimpleContext): boolean {
  const [expert] = useExpertMode();
  const [choices] = useSimpleChoices();
  const localModel = useLocalModelLoaded();
  return simpleShown(id, expert, choices, { localModel, ...context });
}
