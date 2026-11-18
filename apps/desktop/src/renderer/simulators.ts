import { useSyncExternalStore } from 'react';
import type { SimulatorsState, SimulatorsUpdated } from '@nekko-agent/shared';

/**
 * Booted simulators, read from the daemon (`simulators:state`) by one shared
 * sampler for every surface: the monitor chip, the Hardware monitor, the
 * chat's Simulator panel and its status chip (#2814).
 *
 * Each read costs the daemon one `ps`, so it polls every 5 s while a device
 * is booted and every 15 s while none is, never while the window is hidden.
 * The daemon also says when something changed (`simulators:updated`): a
 * device booted after an agent's command, or a chat started on one. Those
 * read at once, so the slow idle poll never delays the chat's panel.
 */

const BUSY_MS = 5_000;
const IDLE_MS = 15_000;

let state: SimulatorsState | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let unsubscribeEvents: (() => void) | null = null;
let inFlight = false;
const listeners = new Set<() => void>();
const usedListeners = new Set<(used: NonNullable<SimulatorsUpdated['used']>) => void>();

function publish(next: SimulatorsState | null) {
  state = next;
  for (const l of listeners) l();
}

function schedule() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (listeners.size === 0) return;
  timer = setTimeout(read, state?.devices.length ? BUSY_MS : IDLE_MS);
}

function read() {
  if (typeof window === 'undefined' || !window.nekko?.simulatorsState) return;
  if (typeof document !== 'undefined' && document.hidden) {
    schedule();
    return;
  }
  if (inFlight) return;
  inFlight = true;
  window.nekko.simulatorsState()
    .then((s) => publish(s))
    .catch(() => {})
    .finally(() => {
      inFlight = false;
      schedule();
    });
}

/** Read again now (after a shutdown, say). */
export function refreshSimulators() {
  read();
}

function onVisible() {
  if (!document.hidden) read();
}

export function subscribeSimulators(fn: () => void): () => void {
  listeners.add(fn);
  if (listeners.size === 1) {
    unsubscribeEvents = window.nekko?.onSimulatorsUpdated?.((e) => {
      read();
      if (e?.used) for (const l of usedListeners) l(e.used);
    }) ?? null;
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
    read();
  }
  return () => {
    listeners.delete(fn);
    if (listeners.size > 0) return;
    if (timer) clearTimeout(timer);
    timer = null;
    unsubscribeEvents?.();
    unsubscribeEvents = null;
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
  };
}

/** The booted devices, or null before the first read (and where the host has none to show). */
export function useSimulators(): SimulatorsState | null {
  return useSyncExternalStore(subscribeSimulators, () => state, () => state);
}

/** A chat just started on a device. Only heard while some surface reads the state. */
export function onSimulatorUsed(cb: (used: NonNullable<SimulatorsUpdated['used']>) => void): () => void {
  usedListeners.add(cb);
  return () => { usedListeners.delete(cb); };
}

/** The last read, for tests. */
export function simulatorsSnapshot(): SimulatorsState | null {
  return state;
}

/** Test hook: forget everything. */
export function resetSimulatorsForTest() {
  if (timer) clearTimeout(timer);
  timer = null;
  state = null;
  inFlight = false;
  listeners.clear();
  usedListeners.clear();
  unsubscribeEvents = null;
}
