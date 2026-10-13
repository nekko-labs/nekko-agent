import { describe, expect, it } from 'vitest';
import { DEFAULT_WALL_DOCK, DEFAULT_WALL_LAYOUT, sanitizeMonthlyBudgetUsd, type AppSettings, type CommandWallSetting } from './settings.js';

describe('monthlyBudgetUsd', () => {
  it('preserves finite non-negative USD amounts, including zero', () => {
    for (const value of [0, 0.01, 100, 1234.56]) expect(sanitizeMonthlyBudgetUsd(value)).toBe(value);
    const setting: Pick<AppSettings, 'monthlyBudgetUsd'> = { monthlyBudgetUsd: 25 };
    expect(sanitizeMonthlyBudgetUsd(setting.monthlyBudgetUsd)).toBe(25);
  });
  it('treats invalid, negative and unset amounts as no budget', () => {
    for (const value of [undefined, null, -1, NaN, Infinity, -Infinity, '100', true, {}, []]) {
      expect(sanitizeMonthlyBudgetUsd(value)).toBeUndefined();
    }
  });
});

describe('command wall settings schema', () => {
  it('allows legacy settings without the new optional fields', () => {
    const legacy: CommandWallSetting = { root: null, autoAdd: true, filter: 'all', insights: { panels: {} }, watermark: 0 };
    expect(legacy.layout).toBeUndefined();
  });
  it('exports reusable layout and dock defaults', () => {
    expect(DEFAULT_WALL_LAYOUT).toEqual({ mode: 'grid', cols: 3, rows: 2 });
    expect(DEFAULT_WALL_DOCK.side).toBe('right');
    expect(DEFAULT_WALL_DOCK.show).toBe(true);
    expect(DEFAULT_WALL_DOCK.minimized).toEqual({
      automations: false, utilization: false, budget: false, insights: false, hardware: false,
    });
    expect(DEFAULT_WALL_DOCK.panelOrder?.[0]).toBe('hardware');
    expect(Object.keys(DEFAULT_WALL_DOCK.minimized)).toEqual(Object.keys(DEFAULT_WALL_DOCK.panels));
    expect(Object.entries(DEFAULT_WALL_DOCK.panels).filter(([, enabled]) => !enabled)).toEqual([['insights', false]]);
  });
});
