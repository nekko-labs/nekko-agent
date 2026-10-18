import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  DEFAULT_PLACEMENT, MAIN_KEY, SWIPE_MS, orderDisplays, pickWindowForAgent, readDisplayPrefs, swipeBounds,
  type ClaimMode, type DisplayInfo, type DisplayPlacement, type DisplaysState, type Rect,
} from '../displayWindows.js';

/**
 * Multi-monitor, the main-process half: one app window per extra screen the
 * user switches on from the Dynamic toolbar's Screens dropdown.
 *
 * The main window's screen is always on. Every other screen's window is the
 * whole app (its own left nav, toolbar and wall), so each screen navigates on
 * its own. Switching a screen on swipes its window in from the screen's left
 * edge until it fills the work area; switching it off shrinks it into the right
 * edge and closes it. The choice survives restarts (`display-windows.json`).
 *
 * New agents are placed here, because only main sees every window: a window
 * that creates an agent itself keeps it; otherwise the placement preference
 * picks an empty screen first or the main window first.
 *
 * Electron is injected (screen, window factory, timers), so the policy is
 * unit-tested without a display server.
 */

export interface ScreenDisplay { id: number; bounds: Rect; workArea: Rect; scaleFactor: number }

export interface ScreenApi {
  getAllDisplays(): ScreenDisplay[];
  getPrimaryDisplay(): ScreenDisplay;
  getDisplayMatching(rect: Rect): ScreenDisplay;
  on(event: 'display-added' | 'display-removed' | 'display-metrics-changed', listener: () => void): void;
}

/** The slice of BrowserWindow this needs. */
export interface ScreenWindow {
  setBounds(bounds: Rect): void;
  getBounds(): Rect;
  show(): void;
  hide?(): void;
  close(): void;
  destroy(): void;
  isDestroyed(): boolean;
  once(event: 'ready-to-show' | 'closed', listener: () => void): void;
  webContents: { id: number; send(channel: string, ...args: unknown[]): void };
}

export interface DisplayWindowsDeps<W extends ScreenWindow = ScreenWindow> {
  screen: ScreenApi;
  dataDir: string;
  /** The main window, or null while it does not exist. */
  mainWindow(): W | null;
  /** Make an app window for a screen, hidden, at `bounds`. */
  createWindow(displayId: string, bounds: Rect): W;
  /** Tell every app window (main included) that the state changed. */
  broadcast(state: (receiver: number) => DisplaysState): void;
  /** Tell the owning window (`main` or a display id) to open an agent another window made. */
  placed?(key: string, sessionId: string): void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  now?: () => number;
}

/** How long an auto-discovered agent waits for the window that made it to speak up. */
export const CLAIM_GRACE_MS = 600;
const FRAME_MS = 16;
const PREFS_FILE = 'display-windows.json';

export function createDisplayWindows<W extends ScreenWindow = ScreenWindow>(deps: DisplayWindowsDeps<W>) {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const now = deps.now ?? (() => Date.now());
  const file = join(deps.dataDir, PREFS_FILE);
  let prefs = (() => {
    try { return existsSync(file) ? readDisplayPrefs(JSON.parse(readFileSync(file, 'utf8'))) : readDisplayPrefs(null); }
    catch { return readDisplayPrefs(null); }
  })();
  const save = () => { try { writeFileSync(file, JSON.stringify(prefs), 'utf8'); } catch { /* non-fatal */ } };

  const windows = new Map<string, W>();
  /** Windows mid swipe-out: still on screen, already off. */
  const leaving = new Set<string>();
  const animations = new Map<string, unknown>();
  /** Window count per wall, keyed `main` or a display id. */
  const panes = new Map<string, number>();
  /** Which window owns each new agent; decided once. */
  const owners = new Map<string, { key: string; at: number }>();
  const pending = new Map<string, { timer: unknown; waiters: Array<(key: string) => void> }>();
  let disposing = false;

  const mainDisplayId = (): string | null => {
    const main = deps.mainWindow();
    return main && !main.isDestroyed() ? String(deps.screen.getDisplayMatching(main.getBounds()).id) : null;
  };

  const keyOf = (webContentsId: number): string | null => {
    const main = deps.mainWindow();
    if (main && !main.isDestroyed() && main.webContents.id === webContentsId) return MAIN_KEY;
    for (const [id, win] of windows) if (!win.isDestroyed() && win.webContents.id === webContentsId) return id;
    return null;
  };

  const state = (receiver: number): DisplaysState => {
    const mainId = mainDisplayId();
    const self = keyOf(receiver);
    const displays: DisplayInfo[] = orderDisplays(deps.screen.getAllDisplays()).map((d, i) => {
      const id = String(d.id);
      const main = id === mainId;
      return {
        id, label: String(i + 1), bounds: d.bounds, main, primary: d.id === deps.screen.getPrimaryDisplay().id,
        enabled: main || (windows.has(id) && !leaving.has(id)), self: main ? self === MAIN_KEY : self === id, scaleFactor: d.scaleFactor,
      };
    });
    return { displays, placement: prefs.placement };
  };
  const changed = () => deps.broadcast(state);

  const stopAnimation = (id: string) => { const t = animations.get(id); if (t !== undefined) clearTimer(t); animations.delete(id); };

  /** Step a window's bounds through a swipe, then call `done`. */
  const animate = (id: string, win: W, area: Rect, direction: 'in' | 'out', done: () => void) => {
    stopAnimation(id);
    const start = now();
    const step = () => {
      if (win.isDestroyed()) { animations.delete(id); return; }
      const t = Math.min(1, (now() - start) / SWIPE_MS);
      win.setBounds(swipeBounds(area, direction, t));
      if (t >= 1) { animations.delete(id); done(); return; }
      animations.set(id, setTimer(step, FRAME_MS));
    };
    step();
  };

  const findDisplay = (id: string) => deps.screen.getAllDisplays().find((d) => String(d.id) === id);

  const open = (id: string, reducedMotion: boolean) => {
    const display = findDisplay(id);
    if (!display || windows.has(id) || id === mainDisplayId()) return;
    const area = display.workArea;
    const win = deps.createWindow(id, reducedMotion ? area : swipeBounds(area, 'in', 0));
    windows.set(id, win);
    panes.set(id, 0);
    win.once('closed', () => {
      stopAnimation(id);
      windows.delete(id);
      leaving.delete(id);
      panes.delete(id);
      // Closed from its own title bar (not by a toggle): that screen is off now.
      // Quitting closes every window too; that keeps the choice for next launch.
      if (!disposing && prefs.enabled.includes(id) && findDisplay(id)) { prefs = { ...prefs, enabled: prefs.enabled.filter((x) => x !== id) }; save(); }
      changed();
    });
    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return;
      win.show();
      if (reducedMotion) win.setBounds(area);
      else animate(id, win, area, 'in', () => win.setBounds(area));
    });
  };

  const close = (id: string, reducedMotion: boolean) => {
    const win = windows.get(id);
    if (!win || win.isDestroyed() || leaving.has(id)) return;
    leaving.add(id);
    const display = findDisplay(id);
    const finish = () => { if (!win.isDestroyed()) win.close(); };
    if (reducedMotion || !display) finish();
    else animate(id, win, display.workArea, 'out', finish);
  };

  /** Open the saved screens that exist and are not the main window's; close windows on screens that left. */
  const sync = (reducedMotion = false) => {
    const present = new Set(deps.screen.getAllDisplays().map((d) => String(d.id)));
    const mainId = mainDisplayId();
    for (const [id, win] of windows) {
      if (!present.has(id) || id === mainId) {
        // Gone, or the main window moved onto it: drop the window, keep the
        // preference for a screen that was only unplugged.
        stopAnimation(id);
        if (id === mainId) prefs = { ...prefs, enabled: prefs.enabled.filter((x) => x !== id) };
        windows.delete(id);
        panes.delete(id);
        if (!win.isDestroyed()) win.destroy();
      }
    }
    save();
    for (const id of prefs.enabled) if (present.has(id) && id !== mainId) open(id, reducedMotion);
    changed();
  };

  const decide = (sessionId: string, key: string) => {
    if (!owners.has(sessionId)) owners.set(sessionId, { key, at: now() });
    const owner = owners.get(sessionId)!.key;
    const wait = pending.get(sessionId);
    if (wait) { clearTimer(wait.timer); pending.delete(sessionId); wait.waiters.forEach((w) => w(owner)); }
    // Forget old decisions so the map stays small over a long session.
    if (owners.size > 500) for (const [s, o] of owners) if (now() - o.at > 10 * 60_000) owners.delete(s);
    return owner;
  };

  const placementTarget = () => {
    const mainId = mainDisplayId();
    const order = orderDisplays(deps.screen.getAllDisplays()).map((d) => String(d.id))
      .map((id) => (id === mainId ? MAIN_KEY : id))
      .filter((key) => key === MAIN_KEY || (windows.has(key) && !leaving.has(key)));
    return pickWindowForAgent(order.map((key) => ({ key, panes: panes.get(key) ?? 0 })), prefs.placement);
  };

  return {
    state,
    /** Screen windows currently open, by display id (for tests and the tray). */
    openIds: () => [...windows.keys()].filter((id) => !leaving.has(id)),
    /** The open window on a screen, if any. */
    windowFor: (id: string) => (leaving.has(id) ? undefined : windows.get(id)),
    /** Open the saved screens; call once the main window exists. */
    start: () => {
      deps.screen.on('display-added', () => sync());
      deps.screen.on('display-removed', () => sync(true));
      deps.screen.on('display-metrics-changed', () => {
        for (const [id, win] of windows) {
          const d = findDisplay(id);
          if (d && !animations.has(id) && !win.isDestroyed()) win.setBounds(d.workArea);
        }
        changed();
      });
      sync();
    },
    /** The main window moved to another screen. */
    mainMoved: () => sync(true),
    toggle(id: string, on: boolean, reducedMotion: boolean): void {
      if (id === mainDisplayId()) return; // the main screen stays on
      if (!findDisplay(id)) return;
      prefs = { ...prefs, enabled: on ? [...new Set([...prefs.enabled, id])] : prefs.enabled.filter((x) => x !== id) };
      save();
      if (on) open(id, reducedMotion); else close(id, reducedMotion);
      changed();
    },
    setPlacement(placement: DisplayPlacement): void {
      prefs = { ...prefs, placement: placement === 'main-first' ? 'main-first' : DEFAULT_PLACEMENT };
      save();
      changed();
    },
    report(sender: number, count: number): void {
      const key = keyOf(sender);
      if (key && Number.isFinite(count) && count >= 0) panes.set(key, Math.floor(count));
    },
    /**
     * Who gets agent `sessionId`. `self`: the sender made it with an explicit
     * action in a screen window, so it keeps it. Otherwise (the main window's
     * own buttons, or an agent that just appeared) placement decides; an agent
     * that just appeared waits briefly in case its creator claims it.
     */
    claim(sender: number, sessionId: string, mode: ClaimMode): Promise<string> {
      const known = owners.get(sessionId);
      if (known) return Promise.resolve(known.key);
      const key = keyOf(sender) ?? MAIN_KEY;
      if (mode === 'self') return Promise.resolve(decide(sessionId, key));
      if (mode === 'place') {
        const owner = decide(sessionId, placementTarget());
        if (owner !== key) deps.placed?.(owner, sessionId);
        return Promise.resolve(owner);
      }
      return new Promise((resolve) => {
        const wait = pending.get(sessionId);
        if (wait) { wait.waiters.push(resolve); return; }
        const timer = setTimer(() => decide(sessionId, placementTarget()), CLAIM_GRACE_MS);
        pending.set(sessionId, { timer, waiters: [resolve] });
      });
    },
    /** The main window went to the tray (or came back): its screens follow. */
    setVisible(visible: boolean): void {
      for (const [id, win] of windows) {
        if (win.isDestroyed() || leaving.has(id)) continue;
        if (visible) { win.show(); } else { stopAnimation(id); const d = findDisplay(id); if (d) win.setBounds(d.workArea); win.hide?.(); }
      }
    },
    /** Close every screen window (quitting), keeping the saved choice. */
    dispose(): void {
      disposing = true;
      for (const id of [...animations.keys()]) stopAnimation(id);
      for (const t of pending.values()) clearTimer(t.timer);
      pending.clear();
      for (const win of windows.values()) if (!win.isDestroyed()) win.destroy();
      windows.clear();
    },
  };
}

export type DisplayWindows<W extends ScreenWindow = Electron.BrowserWindow> = ReturnType<typeof createDisplayWindows<W>>;
