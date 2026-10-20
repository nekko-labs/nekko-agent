import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

export interface WindowBounds {
  width: number;
  height: number;
  x?: number;
  y?: number;
  /** The window was maximised; the other fields are its size when restored. */
  maximized?: boolean;
}

/** A display's usable area (Electron's `Display.workArea`). */
export interface WorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Set by main once it has decided the data directory. Main does not run the
 * host, so the host's own `dataDir()` is not initialised here (reading it
 * threw, the catch below swallowed it, and bounds silently stopped saving).
 */
let dir: string | null = null;
export function setWindowStateDir(path: string): void {
  dir = path;
}

const FILE = () => {
  if (!dir) throw new Error('window state directory not set');
  return join(dir, 'window-state.json');
};

/** The window's floor; also the fallback when a display is too small to size against. */
export const MIN_WINDOW = { width: 900, height: 600 } as const;

/** How much of the work area a first launch takes: most of the screen, not all of it. */
const FIRST_LAUNCH_FRACTION = { width: 0.7, height: 0.8 } as const;

/**
 * Where the window goes the first time, before anything has been saved:
 * 70% of the work area's width and 80% of its height, centred on it, never
 * below the minimum. Decided before the window exists, so it is created at
 * this size rather than resized into it on screen.
 */
export function initialWindowBounds(area: WorkArea): WindowBounds {
  const width = Math.max(MIN_WINDOW.width, Math.round(area.width * FIRST_LAUNCH_FRACTION.width));
  const height = Math.max(MIN_WINDOW.height, Math.round(area.height * FIRST_LAUNCH_FRACTION.height));
  return {
    width,
    height,
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
  };
}

/** The bounds saved by the last run, or null on a first launch (or an unreadable file). */
export function loadWindowBounds(): WindowBounds | null {
  try {
    if (existsSync(FILE())) {
      const saved = JSON.parse(readFileSync(FILE(), 'utf8')) as Partial<WindowBounds>;
      if (typeof saved.width === 'number' && typeof saved.height === 'number') return { ...saved, width: saved.width, height: saved.height };
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function saveWindowBounds(bounds: WindowBounds): void {
  try {
    writeFileSync(FILE(), JSON.stringify(bounds), 'utf8');
  } catch {
    /* non-fatal */
  }
}
