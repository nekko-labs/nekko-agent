import { describe, expect, it } from 'vitest';
import { DEFAULT_WALL_STATE, MONITORS, loadWallState, normalizeMonitorOrder, placeMonitor, reorderMonitor, sanitizeMonitorsDock, saveWallState, toWallSetting } from './commandWall.js';

const defaults = MONITORS.map(p => p.key);

describe('monitor order', () => {
  it('defaults legacy and malformed orders without losing any panels', () => {
    for (const raw of [undefined, null, false, {}, 'hardware', []]) {
      expect(normalizeMonitorOrder(raw)).toEqual(defaults);
    }
    expect(normalizeMonitorOrder(['hardware', 'alien', 'hardware', null, 'budget']))
      .toEqual(['hardware', 'budget', 'localModels', 'utilization', 'automations', 'insights']);
    expect(sanitizeMonitorsDock({}).monitorOrder).toEqual(defaults);
    // The retired Vitals panel drops out of a saved order; Hardware leads by default.
    expect(normalizeMonitorOrder(['vitals', 'budget'])).toEqual(['budget', 'hardware', 'localModels', 'utilization', 'automations', 'insights']);
    expect(defaults[0]).toBe('hardware');
    expect(defaults[1]).toBe('localModels');
    // A dock saved before Local models existed keeps its order; the new monitor joins at the end, switched on.
    const legacy = sanitizeMonitorsDock({ monitorOrder: ['budget', 'hardware', 'utilization', 'automations', 'insights'], monitors: { hardware: true, utilization: true, budget: true, automations: true, insights: false } });
    expect(legacy.monitorOrder).toEqual(['budget', 'hardware', 'utilization', 'automations', 'insights', 'localModels']);
    expect(legacy.monitors.localModels).toBe(true);
    expect(legacy.minimized.localModels).toBe(false);
  });

  it('moves in either direction, keeps all panels, and does not mutate input', () => {
    const original = [...defaults];
    expect(reorderMonitor(original, 'insights', 'budget'))
      .toEqual(['hardware', 'localModels', 'utilization', 'insights', 'budget', 'automations']);
    expect(reorderMonitor(original, 'hardware', 'automations'))
      .toEqual(['localModels', 'utilization', 'budget', 'automations', 'hardware', 'insights']);
    expect(reorderMonitor(original, 'budget', 'budget')).toEqual(original);
    expect(original).toEqual(defaults);
    expect(new Set(reorderMonitor(['hardware', 'hardware'], 'hardware', 'insights')).size).toBe(defaults.length);
  });

  it('places a dropped panel before or after the landing zone anchor', () => {
    const original = [...defaults];
    expect(placeMonitor(original, 'insights', 'budget', 'before'))
      .toEqual(['hardware', 'localModels', 'utilization', 'insights', 'budget', 'automations']);
    expect(placeMonitor(original, 'utilization', 'insights', 'after'))
      .toEqual(['hardware', 'localModels', 'budget', 'automations', 'insights', 'utilization']);
    expect(placeMonitor(original, 'insights', 'hardware', 'before'))
      .toEqual(['insights', 'hardware', 'localModels', 'utilization', 'budget', 'automations']);
    expect(placeMonitor(original, 'budget', 'budget', 'after')).toEqual(original);
    expect(original).toEqual(defaults);
  });

  it('round-trips order through both persistence paths, preserving visibility and minimization', () => {
    const dock = sanitizeMonitorsDock({ side: 'left', monitorOrder: ['hardware', 'insights'], panels: { hardware: false, insights: true }, minimized: { insights: true, utilization: true } });
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
