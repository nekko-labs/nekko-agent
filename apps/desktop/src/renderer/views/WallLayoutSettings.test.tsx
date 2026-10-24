import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AppSettings } from '@nekko-agent/shared';
import { DEFAULT_WALL_STATE, loadWallState, toWallSetting, WALL_STATE_KEY } from '../commandWall.js';
import { WallLayoutSettings, wallLayoutPatch } from './WallLayoutSettings.js';

const settings = { commandWall: toWallSetting({ ...DEFAULT_WALL_STATE, autoAdd: false, layout: { mode: 'grid', rows: 3, cols: 4, fixedGrid: true } }) } as AppSettings;

describe('wall layout settings', () => {
  it('offers Focused and Dynamic, and a Fixed grid toggle with bounded rows and columns', () => {
    const html = renderToStaticMarkup(<WallLayoutSettings settings={settings} update={() => {}} />);
    expect(html).toContain('<option value="grid" selected="">Dynamic</option>');
    expect(html).not.toContain('value="fixed"');
    for (const label of ['Focused', 'Dynamic', 'Fixed grid', 'Grid rows', 'Grid columns', 'Ctrl/Cmd+Shift+1 or 2']) expect(html).toContain(label);
    expect(html).toMatch(/id="wall-fixed-grid" type="checkbox" checked=""/);
    expect(html).toContain('<option value="3" selected="">3</option>');
    expect(html).toContain('<option value="4" selected="">4</option>');
    expect(html).not.toContain('<option value="7"');
  });
  it('disables rows and columns while Fixed grid is off', () => {
    const off = { commandWall: toWallSetting({ ...DEFAULT_WALL_STATE, layout: { mode: 'grid', rows: 3, cols: 4, fixedGrid: false } }) } as AppSettings;
    const html = renderToStaticMarkup(<WallLayoutSettings settings={off} update={() => {}} />);
    expect(html.match(/<select id="wall-grid-\w+"[^>]*disabled=""/g)).toHaveLength(2);
  });
  it('persists mode, Fixed grid and dimensions to the host payload and browser without losing other wall preferences', () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const patch = wallLayoutPatch(settings, { rows: 6 }, storage);
    const loaded = loadWallState(storage, patch.commandWall);
    expect(loaded.layout).toEqual({ mode: 'grid', rows: 6, cols: 4, fixedGrid: true });
    expect(loaded.autoAdd).toBe(false);
    expect(values.has(WALL_STATE_KEY)).toBe(true);
    const free = wallLayoutPatch({ ...settings, ...patch }, { fixedGrid: false }, storage);
    expect(loadWallState(storage, free.commandWall).layout).toEqual({ mode: 'grid', rows: 6, cols: 4, fixedGrid: false });
    const focus = wallLayoutPatch({ ...settings, ...free }, { mode: 'focus' }, storage);
    expect(loadWallState(storage, focus.commandWall).layout).toEqual({ mode: 'focus', rows: 6, cols: 4, fixedGrid: false });
  });
});
