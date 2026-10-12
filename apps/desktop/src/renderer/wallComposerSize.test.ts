import { afterEach, describe, expect, it, vi } from 'vitest';
import { composerMaxWidth, DEFAULT_WALL_STATE, loadWallState, readDock, saveWallState, toWallSetting } from './commandWall.js';

/**
 * The wall composer's dragged size used to live in component state, so leaving
 * the Agents page (which unmounts the wall) threw it away, and its widest was
 * the composer row's width, which overshoots the windows above it because the
 * row and the wall inset their content differently.
 */

describe('composer size is part of the saved wall', () => {
  it('keeps a dragged width and height through save and load', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    const state = { ...DEFAULT_WALL_STATE, composer: { side: 'bottom' as const, align: 'center' as const, width: 1789, height: 412 } };
    saveWallState(storage, state);
    expect(loadWallState(storage).composer).toEqual({ side: 'bottom', align: 'center', width: 1789, height: 412 });
    // And through the setting, which is what the desktop, web and phone share.
    expect(loadWallState(undefined, toWallSetting(state)).composer).toMatchObject({ width: 1789, height: 412 });
  });

  it('treats a missing size as the default, so walls saved before this load unchanged', () => {
    expect(readDock({ side: 'top', align: 'left' })).toEqual({ side: 'top', align: 'left' });
    expect(readDock(undefined)).toEqual({ side: 'bottom', align: 'center' });
  });

  it('drops a damaged size rather than drawing it', () => {
    for (const bad of [NaN, Infinity, -5, 3, '900', null, 1e9]) {
      expect(readDock({ side: 'bottom', align: 'center', width: bad, height: bad })).toEqual({ side: 'bottom', align: 'center' });
    }
    expect(readDock({ width: 640.6, height: 300.2 })).toMatchObject({ width: 641, height: 300 });
  });
});

describe('the widest the composer can be', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** A composer panel inside its row inside the wall column, as the DOM has them. */
  const build = (stageWidth: number | null, rowWidth: number, rowPadding: number) => {
    vi.stubGlobal('getComputedStyle', () => ({ paddingLeft: `${rowPadding}px`, paddingRight: `${rowPadding}px` }));
    const stage = stageWidth === null ? null : { getBoundingClientRect: () => ({ width: stageWidth }) };
    const column = { querySelector: (sel: string) => (sel === '.command-wall-stage' ? stage : null) };
    const row = { clientWidth: rowWidth };
    return { parentElement: row, closest: (sel: string) => (sel === '.wall-column' ? column : null) } as unknown as HTMLElement;
  };

  it('is the width of the windows above it, not of the composer row', () => {
    // As measured in the reported recording: windows 1792px wide; the row's
    // content box (minus 16px each side) came to 1796px and overshot them.
    expect(composerMaxWidth(build(1792, 1828, 16))).toBe(1792);
  });

  it('falls back to the row content box when the wall has no stage', () => {
    expect(composerMaxWidth(build(null, 1000, 16))).toBe(968);
  });

  it('has a guess when nothing is mounted', () => {
    expect(composerMaxWidth(null)).toBe(1000);
  });
});

describe('saving the composer size when leaving the page', () => {
  it('flushes a change still inside the settle delay on unmount and on window close', async () => {
    const { readFileSync } = await import('node:fs');
    const view = readFileSync(new URL('./views/CommandCenterView.tsx', import.meta.url), 'utf8');
    // Otherwise a resize just before switching tabs is lost: the next load
    // prefers the host's older setting over the browser copy.
    expect(view).toContain('unsaved.current = wall;');
    expect(view).toContain("window.addEventListener('beforeunload', flushWall);");
    expect(view).toContain("return () => { window.removeEventListener('beforeunload', flushWall); flushWall(); };");
  });
});
