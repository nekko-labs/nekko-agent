import { describe, expect, it } from 'vitest';
import { RUN_POLICY_OPTIONS, effectiveRunPolicy, runPolicyLabel, runPolicyNote } from './tasks.js';

describe('run policy', () => {
  it('defaults by where the model runs, as the daemon does', () => {
    expect(effectiveRunPolicy(undefined, {}, true)).toBe('idle');
    expect(effectiveRunPolicy(undefined, null, false)).toBe('always');
    // A cleared setting is null.
    expect(effectiveRunPolicy(null, { automationRunPolicy: null }, true)).toBe('idle');
    expect(effectiveRunPolicy(undefined, { automationRunPolicy: 'lowPriority' }, false)).toBe('lowPriority');
    expect(effectiveRunPolicy('always', { automationRunPolicy: 'lowPriority' }, true)).toBe('always');
  });

  it('names every policy and says how a run started', () => {
    expect(RUN_POLICY_OPTIONS.map((o) => o.id)).toEqual(['idle', 'lowPriority', 'always']);
    expect(runPolicyLabel('idle')).toBe('Only when I’m away');
    expect(runPolicyNote(undefined, undefined)).toBeUndefined();
    expect(runPolicyNote(true, undefined)).toBe('low priority');
    expect(runPolicyNote(true, 7_200_000)).toBe('low priority · waited 2 hr');
    // Under a minute is not worth saying.
    expect(runPolicyNote(false, 20_000)).toBeUndefined();
  });
});
