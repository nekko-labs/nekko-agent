/**
 * Multi-monitor (Dynamic mode): one app window per screen the user switches
 * on. Shared by main (which owns the windows), preload (the bridge) and the
 * renderer (the toolbar's Screens dropdown and the placement of new agents).
 *
 * Kept out of `IpcChannels` on purpose, like the window chrome: these are
 * desktop-shell channels answered by Electron main, never by the engine, and
 * a browser tab has no screens to spread over.
 */

export const DISPLAYS_LIST_CHANNEL = 'displays:list';
export const DISPLAYS_TOGGLE_CHANNEL = 'displays:toggle';
export const DISPLAYS_PLACEMENT_CHANNEL = 'displays:placement';
export const DISPLAYS_REPORT_CHANNEL = 'displays:report';
export const DISPLAYS_CLAIM_CHANNEL = 'displays:claim';
export const DISPLAYS_DESKTOP_CHANNEL = 'displays:desktop';
export const DISPLAYS_SPACES_MODE_CHANNEL = 'displays:spaces-mode';
export const DISPLAYS_GO_CHANNEL = 'displays:go';
/** main → every app window: the screens or their windows changed. */
export const DISPLAYS_CHANGED_EVENT = 'displays:changed';
/** The command-line switch that tells a screen window which display it fills. */
export const DISPLAY_ARG = '--nekko-display=';

/**
 * Where a new agent window opens when more than one screen is on.
 *  - `empty-first`: a screen whose wall is empty, else the one with the fewest windows (the main screen wins ties).
 *  - `main-first`: the main screen; other screens only get the agents opened there.
 */
export type DisplayPlacement = 'empty-first' | 'main-first';
export const DEFAULT_PLACEMENT: DisplayPlacement = 'empty-first';

export interface Rect { x: number; y: number; width: number; height: number }

/** One physical screen, as the Screens dropdown lists it. */
export interface DisplayInfo {
  id: string;
  /** "1", "2", ... left to right, then top to bottom. */
  label: string;
  bounds: Rect;
  /** The screen the main window is on: always on, cannot be switched off. */
  main: boolean;
  /** The OS's primary display. */
  primary: boolean;
  /** A Nekko window is open on it (always true for the main screen). */
  enabled: boolean;
  /** The window asking is the one on this screen. */
  self: boolean;
  scaleFactor: number;
}

export interface DisplaysState {
  displays: DisplayInfo[];
  placement: DisplayPlacement;
  /** macOS desktops (Spaces) on the main window's screen; only when there are two or more. */
  spaces?: SpacesInfo;
}

/**
 * How turning on another desktop gets you there. macOS has no public API to
 * put a window on a chosen desktop, so the window appears on whichever desktop
 * is active when it is shown.
 *  - `ask`: not chosen yet; the dropdown explains the Accessibility permission first.
 *  - `switch`: jump there now (Ctrl+number or Ctrl+arrow keystrokes, which need Accessibility).
 *  - `arrive`: the window waits and opens the next time you switch to that desktop.
 */
export type SpacesMode = 'ask' | 'switch' | 'arrive';

/** One macOS desktop, as the Screens dropdown lists it. */
export interface DesktopInfo {
  /** The window key for this desktop's Nekko window (`space-<ManagedSpaceID>`). */
  id: string;
  /** "1", "2", ...: Mission Control's Desktop number. */
  label: string;
  /** The desktop you are on now. */
  current: boolean;
  /** The main window's desktop: always on. */
  main: boolean;
  /** A Nekko window is open on it, or waiting to open there. */
  enabled: boolean;
  /** Turned on in `arrive` mode, not visited yet. */
  waiting: boolean;
  /** The window asking is the one on this desktop. */
  self: boolean;
}

export interface SpacesInfo {
  desktops: DesktopInfo[];
  mode: SpacesMode;
  /** Accessibility is granted, so switching desktops works. */
  access: boolean;
}

/** Where a spoken "switch to ..." command goes. */
export type GoTarget = { kind: 'desktop'; n: number } | { kind: 'desktop'; step: 1 | -1 } | { kind: 'screen'; n: number };

/** Why `go` could not finish, for the caller to explain. */
export type GoResult = 'ok' | 'needs-access' | 'not-found';

/** What `window.nekkoChrome.displays` offers the renderer. */
export interface DisplaysBridge {
  /** This window's screen, or null for the main window. */
  displayId: string | null;
  list(): Promise<DisplaysState>;
  toggle(id: string, on: boolean, reducedMotion: boolean): Promise<DisplaysState>;
  setPlacement(placement: DisplayPlacement): Promise<DisplaysState>;
  /** Turn a desktop's Nekko window on or off (macOS Spaces). */
  toggleDesktop(id: string, on: boolean): Promise<DisplaysState>;
  /** Choose how a desktop is reached; `switch` asks macOS for Accessibility if needed. */
  setSpacesMode(mode: Exclude<SpacesMode, 'ask'>): Promise<DisplaysState>;
  /** Voice: switch desktops, or bring up a screen's window (turning it on). */
  go(target: GoTarget): Promise<GoResult>;
  /** How many windows this screen's wall shows; feeds `empty-first`. */
  report(panes: number): void;
  /**
   * Which window takes a new agent, decided once per session; answers its key
   * (`'main'` or a display id). `self`: made by a click in a screen window,
   * which keeps it. `place`: made from the main window, so the placement
   * preference picks. `auto`: it just appeared (CLI, phone, automation);
   * placement picks after a short wait for its creator to claim it.
   */
  claim(sessionId: string, mode: ClaimMode): Promise<string>;
  onChange(listener: (state: DisplaysState) => void): () => void;
  /** An agent made elsewhere was placed on this window's screen. */
  onPlaced(listener: (sessionId: string) => void): () => void;
}

export type ClaimMode = 'self' | 'place' | 'auto';
/** main → the owning window: open this agent on your wall. */
export const DISPLAYS_PLACED_EVENT = 'displays:placed';

/** The main window's key in claims and pane reports. */
export const MAIN_KEY = 'main';

/** Number screens in reading order: left to right, then top to bottom. */
export function orderDisplays<T extends { bounds: Rect }>(displays: T[]): T[] {
  return [...displays].sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
}

/**
 * Pick the window for a new agent. `windows` are the open ones (the main
 * window keyed `main`), in screen order, with their wall's window count.
 */
export function pickWindowForAgent(windows: Array<{ key: string; panes: number }>, placement: DisplayPlacement): string {
  if (placement === 'main-first' || windows.length <= 1) return MAIN_KEY;
  const main = windows.find((w) => w.key === MAIN_KEY);
  const empty = windows.find((w) => w.key !== MAIN_KEY && w.panes === 0);
  if (main && main.panes === 0) return MAIN_KEY;
  if (empty) return empty.key;
  return windows.reduce((best, w) => (w.panes < best.panes ? w : best), main ?? windows[0]).key;
}

/** Narrow a saved file to the shape main expects; anything malformed reads as the default. */
export function readDisplayPrefs(raw: unknown): { enabled: string[]; placement: DisplayPlacement; spacesMode: SpacesMode } {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const enabled = Array.isArray(r.enabled) ? [...new Set(r.enabled.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length < 64))] : [];
  const placement = r.placement === 'main-first' ? 'main-first' : 'empty-first';
  const spacesMode = r.spacesMode === 'switch' || r.spacesMode === 'arrive' ? r.spacesMode : 'ask';
  return { enabled, placement, spacesMode };
}

/** The strip a screen window starts from and shrinks into. */
export const SWIPE_EDGE = 64;
/** How long the swipe takes, in ms. */
export const SWIPE_MS = 280;

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const easeInCubic = (t: number) => t * t * t;

/**
 * The window's bounds `t` (0..1) of the way through a swipe. `in` grows from
 * a strip on the screen's left edge to fill it (left edge pinned, so it
 * reads as a swipe from the left); `out` shrinks into a strip on the right
 * edge (right edge pinned) before the window closes.
 */
export function swipeBounds(area: Rect, direction: 'in' | 'out', t: number): Rect {
  const p = Math.max(0, Math.min(1, t));
  const edge = Math.min(SWIPE_EDGE, area.width);
  if (direction === 'in') {
    const width = Math.round(edge + (area.width - edge) * easeOutCubic(p));
    return { x: area.x, y: area.y, width, height: area.height };
  }
  const width = Math.round(area.width - (area.width - edge) * easeInCubic(p));
  return { x: area.x + area.width - width, y: area.y, width, height: area.height };
}
