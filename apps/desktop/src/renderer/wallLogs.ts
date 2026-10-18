import { create } from 'zustand';

/** What a wall drawer shows: the agent's command log, or one of its companions. */
export type WallDrawerKind = 'logs' | 'diff' | 'files' | 'browser';

/**
 * Which agent's drawer is out on the Agents wall, and what it shows (Logs,
 * Changes, Files or Browser). One at a time: the drawer slides out of its
 * window's right edge and the wall makes room for it. `closing` keeps the
 * drawer mounted while it is absorbed back into the window, but the wall
 * already lays out as if it were gone so the neighbours slide back at the
 * same time.
 */
export interface WallLogsState {
  sessionId: string | null;
  kind: WallDrawerKind;
  closing: boolean;
  /** Open this agent's drawer on `kind`; the same one again closes it. */
  toggle: (sessionId: string, kind?: WallDrawerKind) => void;
  close: () => void;
  /** The close animation finished: unmount the drawer. */
  closed: () => void;
}

export const useWallLogs = create<WallLogsState>((set, get) => ({
  sessionId: null,
  kind: 'logs',
  closing: false,
  toggle: (sessionId, kind = 'logs') => {
    const s = get();
    if (s.sessionId === sessionId && s.kind === kind && !s.closing) set({ closing: true });
    else set({ sessionId, kind, closing: false });
  },
  close: () => { if (get().sessionId) set({ closing: true }); },
  closed: () => { if (get().closing) set({ sessionId: null, closing: false }); },
}));

export interface Rect { x: number; y: number; width: number; height: number }

/** The overlay drawer's share of its window's height (one-column walls). */
export const LOGS_DRAWER_HEIGHT = 0.96;
/**
 * How far the side drawer sits in from its window's top and bottom: the
 * window's corner radius (14px) plus the concave fillet (12px, styles.css
 * `--logs-fillet`) that flows the window's edge into the drawer. Smaller, and
 * the fillet would run into the window's rounded corner.
 */
export const LOGS_DRAWER_INSET = 26;
const MIN_DRAWER = 280;
const MIN_CHAT = 320;
/** The narrowest a window beside the drawer is squeezed to. */
const MIN_SIDE = 240;

/** 40% of the wall, 425 to 700px: a quarter larger than the original 32% (340 to 560px). */
export function logsDrawerWidth(stageWidth: number): number {
  return Math.round(Math.max(425, Math.min(700, stageWidth * 0.4)));
}

/**
 * Lay the wall out around an open log drawer. The drawer hangs off the target
 * window's right edge, LOGS_DRAWER_INSET in from its top and bottom. Windows to the
 * right that share its rows slide right by the drawer's width, squeezed into
 * what is left of the stage when they can stay usable; the target narrows
 * when it is the rightmost window and nothing else can give way. Pure: the
 * saved layout is never touched.
 */
export function layoutWithLogsDrawer(
  panes: Map<string, Rect>,
  targetId: string,
  stageWidth: number,
): { panes: Map<string, Rect>; drawer: Rect | null } {
  const t = panes.get(targetId);
  if (!t || stageWidth <= 0) return { panes, drawer: null };
  const next = new Map(panes);
  let width = logsDrawerWidth(stageWidth);
  const right = t.x + t.width;
  const top = t.y, bottom = t.y + t.height;
  const beside = [...panes].filter(([id, r]) => id !== targetId && r.x >= right - 1 && r.y < bottom - 1 && r.y + r.height > top + 1);

  let targetWidth = t.width;
  if (beside.length === 0) {
    // Nothing to push: take the room from the window's own width.
    const room = stageWidth - right;
    if (room < width) targetWidth = Math.max(Math.min(t.width, MIN_CHAT), stageWidth - t.x - width);
    width = Math.max(MIN_DRAWER, Math.min(width, stageWidth - (t.x + targetWidth)));
  } else {
    // Squeeze the neighbours into what is left, never below MIN_SIDE each; the
    // drawer itself gives way (down to MIN_DRAWER) before anything is pushed
    // off the wall. Only when even that cannot fit do they slide right whole.
    const region = stageWidth - right;
    const minScale = Math.max(...beside.map(([, r]) => MIN_SIDE / Math.max(1, r.width)));
    // Floor, not round: rounding up past region * (1 - minScale) leaves the
    // squeeze a hair under minScale and pushes the neighbours off the wall.
    width = Math.floor(Math.max(MIN_DRAWER, Math.min(width, region * (1 - minScale))));
    const squeeze = region > width ? (region - width) / region : 0;
    const usable = squeeze >= minScale - 1e-9;
    for (const [id, r] of beside) {
      next.set(id, usable
        ? { ...r, x: right + width + (r.x - right) * squeeze, width: r.width * squeeze }
        : { ...r, x: r.x + width });
    }
  }
  next.set(targetId, { ...t, width: targetWidth });
  const inset = Math.min(LOGS_DRAWER_INSET, Math.floor(t.height / 4));
  return { panes: next, drawer: { x: t.x + targetWidth, y: t.y + inset, width, height: Math.max(1, t.height - inset * 2) } };
}

/**
 * On a wall too narrow to make room (one column), the drawer sits over the
 * right of its window instead, so Logs still opens it there. Nothing moves.
 */
export function overlayLogsDrawer(
  panes: Map<string, Rect>,
  targetId: string,
): { panes: Map<string, Rect>; drawer: Rect | null; overlay: true } {
  const t = panes.get(targetId);
  if (!t) return { panes, drawer: null, overlay: true };
  const inset = 12;
  const width = Math.max(1, Math.min(700, t.width - inset * 2));
  const h = Math.max(1, Math.round(t.height * LOGS_DRAWER_HEIGHT));
  return { panes, drawer: { x: t.x + t.width - inset - width, y: t.y + Math.round((t.height - h) / 2), width, height: h }, overlay: true };
}
