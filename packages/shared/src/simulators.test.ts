import { describe, expect, it } from 'vitest';
import type { BootedSimulator } from './simulators.js';
import { simulatorDetail, simulatorDuration, simulatorIdleLabel, simulatorUsedLabel, simulatorsCpu, simulatorsForSession } from './simulators.js';

const NOW = Date.UTC(2026, 10, 15, 9, 0, 0);
const MIN = 60_000;

function device(over: Partial<BootedSimulator> = {}): BootedSimulator {
  return { id: 'A', kind: 'ios', name: 'Nekko-1314-iPad', cpuPct: 1, upSecs: 600, processes: 300, canOpen: true, ...over };
}

describe('simulator wording', () => {
  it('says durations the short way', () => {
    expect(simulatorDuration(45_000)).toBe('45s');
    expect(simulatorDuration(12 * MIN)).toBe('12 min');
    expect(simulatorDuration(3 * 60 * MIN)).toBe('3 h');
    expect(simulatorDuration(9 * 24 * 60 * MIN)).toBe('9 days');
  });

  it('calls a quiet device nothing touched for nine days idle 9 days', () => {
    const d = device({ upSecs: 9 * 86_400, cpuPct: 0.6 });
    expect(simulatorIdleLabel(d, NOW)).toBe('idle 9 days');
    // Since the agent's last command, not since boot.
    expect(simulatorIdleLabel({ ...d, lastUse: { sessionId: 's', at: NOW - 2 * 60 * MIN } }, NOW)).toBe('idle 2 h');
  });

  it('does not call a busy or recently used device idle', () => {
    expect(simulatorIdleLabel(device({ upSecs: 9 * 86_400, cpuPct: 35 }), NOW)).toBeNull();
    expect(simulatorIdleLabel(device({ upSecs: 9 * 86_400, lastUse: { sessionId: 's', at: NOW - 5 * MIN } }), NOW)).toBeNull();
    expect(simulatorIdleLabel(device({ upSecs: 20 * 60 }), NOW)).toBeNull();
  });

  it('names the chat that used it, or an agent when the chat has no title', () => {
    expect(simulatorUsedLabel(device({ lastUse: { sessionId: 's', at: NOW - 2 * MIN, title: 'iPad PanesTests' } }), NOW)).toBe('used by iPad PanesTests, 2 min ago');
    expect(simulatorUsedLabel(device({ lastUse: { sessionId: 's', at: NOW - 10_000, title: null } }), NOW)).toBe('used by an agent now');
    expect(simulatorUsedLabel(device(), NOW)).toBeNull();
  });

  it('joins the model and OS', () => {
    expect(simulatorDetail(device({ model: 'iPad Pro 13-inch (M5)', os: 'iOS 26.5' }))).toBe('iPad Pro 13-inch (M5) · iOS 26.5');
    expect(simulatorDetail(device())).toBe('');
  });

  it('picks a chat’s devices, most recently used first, and sums CPU', () => {
    const state = {
      sampledAt: NOW,
      devices: [
        device({ id: 'A', cpuPct: 95, lastUse: { sessionId: 's1', at: NOW - 5 * MIN } }),
        device({ id: 'B', cpuPct: 35, lastUse: { sessionId: 's2', at: NOW } }),
        device({ id: 'C', cpuPct: 16, lastUse: { sessionId: 's1', at: NOW - MIN } }),
      ],
    };
    expect(simulatorsForSession(state, 's1').map((d) => d.id)).toEqual(['C', 'A']);
    expect(simulatorsForSession(state, null)).toEqual([]);
    expect(simulatorsForSession(null, 's1')).toEqual([]);
    expect(simulatorsCpu(state)).toBe(146);
  });
});
