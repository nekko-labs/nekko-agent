import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AppSettings } from '@nekko-agent/shared';
import { DEFAULT_WALL_STATE, loadWallState, toWallSetting, WALL_STATE_KEY } from '../commandWall.js';
import { WallLayoutSettings, wallLayoutPatch } from './WallLayoutSettings.js';

const settings = { commandWall: toWallSetting({ ...DEFAULT_WALL_STATE, autoAdd: false, layout: { mode: 'fixed', rows: 3, cols: 4 } }) } as AppSettings;

describe('wall layout settings', () => {
  it('offers all saved modes and bounded rows and columns with the saved Grid selected', () => {
    const html = renderToStaticMarkup(<WallLayoutSettings settings={settings} update={() => {}} />);
    expect(html).toContain('<option value="fixed" selected="">Grid</option>');
    for (const label of ['Focused', 'Dynamic', 'Grid rows', 'Grid columns', 'Ctrl/Cmd+Shift+1, 2 or 3']) expect(html).toContain(label);
    expect(html).toContain('<option value="3" selected="">3</option>');
    expect(html).toContain('<option value="4" selected="">4</option>');
    expect(html).not.toContain('<option value="7"');
  });
  it('persists mode and dimensions to the host payload and browser without losing other wall preferences', () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const patch = wallLayoutPatch(settings, { rows: 6 }, storage);
    const loaded = loadWallState(storage, patch.commandWall);
    expect(loaded.layout).toEqual({ mode: 'fixed', rows: 6, cols: 4 });
    expect(loaded.autoAdd).toBe(false);
    expect(values.has(WALL_STATE_KEY)).toBe(true);
    const dynamic = wallLayoutPatch({ ...settings, ...patch }, { mode: 'grid' }, storage);
    expect(loadWallState(storage, dynamic.commandWall).layout).toEqual({ mode: 'grid', rows: 6, cols: 4 });
    const grid = wallLayoutPatch({ ...settings, ...dynamic }, { mode: 'fixed' }, storage);
    expect(loadWallState(storage, grid.commandWall).layout).toEqual({ mode: 'fixed', rows: 6, cols: 4 });
  });
});
