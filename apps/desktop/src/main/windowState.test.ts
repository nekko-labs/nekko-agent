import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initialWindowBounds, loadWindowBounds, saveWindowBounds, setWindowStateDir } from './windowState.js';

describe('window state', () => {
  it('round-trips bounds through the directory main sets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nekko-window-'));
    setWindowStateDir(dir);
    expect(loadWindowBounds()).toBeNull();
    saveWindowBounds({ width: 1500, height: 900, x: 10, y: 20 });
    expect(loadWindowBounds()).toEqual({ width: 1500, height: 900, x: 10, y: 20 });
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps a maximised window maximised', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nekko-window-'));
    setWindowStateDir(dir);
    saveWindowBounds({ width: 1500, height: 900, x: 10, y: 20, maximized: true });
    expect(loadWindowBounds()).toEqual({ width: 1500, height: 900, x: 10, y: 20, maximized: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it('opens a first launch at 70% by 80% of the work area, centred', () => {
    // A 2560x1440 display with a 40px taskbar at the bottom.
    expect(initialWindowBounds({ x: 0, y: 0, width: 2560, height: 1400 })).toEqual({ width: 1792, height: 1120, x: 384, y: 140 });
    // A second display to the left of the primary keeps its own origin.
    expect(initialWindowBounds({ x: -1920, y: 0, width: 1920, height: 1040 })).toEqual({ width: 1344, height: 832, x: -1632, y: 104 });
  });

  it('never goes below the window minimum on a small display', () => {
    expect(initialWindowBounds({ x: 0, y: 0, width: 1024, height: 700 })).toMatchObject({ width: 900, height: 600 });
  });
});
