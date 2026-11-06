/**
 * The renderer's half of multi-monitor (see `src/displayWindows.ts`).
 *
 * Each screen window runs the whole app on its own; this module tells a
 * window which screen it is, lets the Dynamic toolbar list and toggle screens,
 * keeps per-screen wall state apart, and decides whether an agent that
 * appeared belongs on this window's wall.
 */
import { useEffect, useState } from 'react';
import type { WallLayoutMode } from '@nekko-agent/shared';
import type { ClaimMode, DisplaysBridge, DisplaysState } from '../displayWindows.js';
export type { DesktopInfo, DisplayInfo, DisplayPlacement, DisplaysState, GoTarget, SpacesMode } from '../displayWindows.js';
export { MAIN_KEY } from '../displayWindows.js';

/** The bridge, or undefined outside the desktop shell. */
export const displaysBridge: DisplaysBridge | undefined = typeof window === 'undefined'
  ? undefined
  : (window as unknown as { nekkoChrome?: { displays?: DisplaysBridge } }).nekkoChrome?.displays;

/** This window's screen id, or null for the main window (and outside the desktop shell). */
export const screenDisplayId: string | null = displaysBridge?.displayId ?? null;

/** True in a multi-monitor screen window (not the main window). */
export const isScreenWindow = screenDisplayId !== null;

/** The key this window's wall uses in claims (`main` or a display id). */
export const windowKey = screenDisplayId ?? 'main';

/**
 * Where this window keeps its Agents wall in the browser's storage. The main
 * window keeps the original key (and the wall setting it shares with the web
 * and phone editions); a screen window has a wall of its own per screen.
 */
export function wallStorageKey(base: string, displayId: string | null = screenDisplayId): string {
  return displayId ? `${base}.display.${displayId}` : base;
}

const OPENER_MODE_KEY = 'nekko.screenOpenerMode';

/** Remember the wall mode of the window switching a screen on, for the window it opens. */
export function rememberOpenerMode(mode: WallLayoutMode): void {
  try { localStorage.setItem(OPENER_MODE_KEY, mode); } catch { /* storage blocked: the new window opens Dynamic */ }
}

/** The mode a newly opened screen window starts in. */
export function openerMode(): WallLayoutMode {
  try { return localStorage.getItem(OPENER_MODE_KEY) === 'focus' ? 'focus' : 'grid'; } catch { return 'grid'; }
}

/** The live screen list and placement, or null outside the desktop shell. */
export function useDisplays(): [DisplaysState | null, (next: DisplaysState) => void] {
  const [state, setState] = useState<DisplaysState | null>(null);
  useEffect(() => {
    if (!displaysBridge) return;
    let live = true;
    void displaysBridge.list().then((s) => { if (live) setState(s); }).catch(() => {});
    const off = displaysBridge.onChange((s) => setState(s));
    return () => { live = false; off(); };
  }, []);
  return [state, setState];
}

/**
 * Ask main which window owns a new agent. Outside the desktop shell, or when
 * main cannot answer, the asking window keeps it (the single-window behavior).
 */
export async function claimAgent(sessionId: string, mode: ClaimMode): Promise<string> {
  if (!displaysBridge) return windowKey;
  try { return await displaysBridge.claim(sessionId, mode); } catch { return windowKey; }
}

/** Whether the OS asks for less motion, so a screen window appears without the swipe. */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}
