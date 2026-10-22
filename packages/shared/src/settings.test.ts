import { describe, expect, it } from 'vitest';
import { DEFAULT_MONITORS_DOCK, DEFAULT_WALL_LAYOUT, type CommandWallSetting } from './settings.js';

describe('command wall settings schema', () => {
  it('allows legacy settings without the new optional fields', () => {
    const legacy: CommandWallSetting = { root: null, autoAdd: true, filter: 'all', insights: { panels: {} }, watermark: 0 };
    expect(legacy.layout).toBeUndefined();
  });
  it('exports reusable layout and dock defaults', () => {
    expect(DEFAULT_WALL_LAYOUT).toEqual({ mode: 'grid', cols: 3, rows: 2 });
    expect(DEFAULT_MONITORS_DOCK.side).toBe('right');
    expect(DEFAULT_MONITORS_DOCK.show).toBe(true);
    expect(DEFAULT_MONITORS_DOCK.minimized).toEqual({
      automations: false, utilization: false, budget: false, insights: false, hardware: false, localModels: false,
    });
    expect(DEFAULT_MONITORS_DOCK.monitorOrder?.[0]).toBe('hardware');
    expect(DEFAULT_MONITORS_DOCK.monitorOrder?.[1]).toBe('localModels');
    expect(Object.keys(DEFAULT_MONITORS_DOCK.minimized)).toEqual(Object.keys(DEFAULT_MONITORS_DOCK.monitors));
    expect(Object.entries(DEFAULT_MONITORS_DOCK.monitors).filter(([, enabled]) => !enabled)).toEqual([['insights', false]]);
  });
});
