import { describe, expect, it } from 'vitest';
import { DEFAULT_WALL_STATE, MONITORS, loadWallState, normalizeMonitorOrder, placeMonitor, reorderMonitor, sanitizeMonitorsDock, saveWallState, toWallSetting } from './commandWall.js';

const defaults = MONITORS.map(p => p.key);

describe('monitor order', () => {
  it('defaults legacy and malformed orders without losing any panels', () => {
    for (const raw of [undefined, null, false, {}, 'hardware', []]) {
      expect(normalizeMonitorOrder(raw)).toEqual(defaults);
    }
    expect(normalizeMonitorOrder(['hardware', 'alien', 'hardware', null, 'budget']))
      .toEqual(['hardware', 'budget', 'localModels', 'utilization', 'automations']);
    expect(sanitizeMonitorsDock({}).monitorOrder).toEqual(defaults);
    // The retired Vitals and Insights panels drop out of a saved order; Hardware leads by default.
    expect(normalizeMonitorOrder(['vitals', 'insights', 'budget'])).toEqual(['budget', 'hardware', 'localModels', 'utilization', 'automations']);
    expect(defaults[0]).toBe('hardware');
    expect(defaults[1]).toBe('localModels');
    // A dock saved before Local models existed keeps its order; the new monitor joins at the end, switched on.
    const legacy = sanitizeMonitorsDock({ monitorOrder: ['budget', 'hardware', 'utilization', 'automations'], monitors: { hardware: true, utilization: true, budget: true, automations: true } });
    expect(legacy.monitorOrder).toEqual(['budget', 'hardware', 'utilization', 'automations', 'localModels']);
    expect(legacy.monitors.localModels).toBe(true);
    expect(legacy.minimized.localModels).toBe(false);
  });

  it('moves in either direction, keeps all panels, and does not mutate input', () => {
    const original = [...defaults];
    expect(reorderMonitor(original, 'automations', 'utilization'))
      .toEqual(['hardware', 'localModels', 'automations', 'utilization', 'budget']);
    expect(reorderMonitor(original, 'hardware', 'automations'))
      .toEqual(['localModels', 'utilization', 'budget', 'automations', 'hardware']);
    expect(reorderMonitor(original, 'budget', 'budget')).toEqual(original);
    expect(original).toEqual(defaults);
    expect(new Set(reorderMonitor(['hardware', 'hardware'], 'hardware', 'automations')).size).toBe(defaults.length);
  });

  it('places a dropped panel before or after the landing zone anchor', () => {
    const original = [...defaults];
    expect(placeMonitor(original, 'automations', 'budget', 'before'))
      .toEqual(['hardware', 'localModels', 'utilization', 'automations', 'budget']);
    expect(placeMonitor(original, 'utilization', 'automations', 'after'))
      .toEqual(['hardware', 'localModels', 'budget', 'automations', 'utilization']);
    expect(placeMonitor(original, 'automations', 'hardware', 'before'))
      .toEqual(['automations', 'hardware', 'localModels', 'utilization', 'budget']);
    expect(placeMonitor(original, 'budget', 'budget', 'after')).toEqual(original);
    expect(original).toEqual(defaults);
  });

  it('round-trips order through both persistence paths, preserving visibility and minimization', () => {
    const dock = sanitizeMonitorsDock({ side: 'left', monitorOrder: ['hardware', 'budget'], panels: { hardware: false, budget: true }, minimized: { budget: true, utilization: true } });
    const state = { ...DEFAULT_WALL_STATE, dock: { ...dock, monitorOrder: reorderMonitor(dock.monitorOrder, 'automations', 'hardware') } };
    let saved = '';
    const storage = { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value; } };
    saveWallState(storage, state);
    expect(loadWallState(storage).dock).toEqual(state.dock);
    expect(loadWallState(undefined, toWallSetting(state)).dock).toEqual(state.dock);
    expect(state.dock.monitors).toEqual(dock.monitors);
    expect(state.dock.minimized).toEqual(dock.minimized);
  });
});
