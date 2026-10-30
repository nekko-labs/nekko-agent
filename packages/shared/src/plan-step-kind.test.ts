import { describe, expect, it } from 'vitest';
import { applyPlanUpdate, type PlanStep } from './training.js';

const apply = (current: PlanStep[] | undefined, input: Parameters<typeof applyPlanUpdate>[1]): PlanStep[] => {
  const result = applyPlanUpdate(current, input);
  if ('error' in result) throw new Error(result.error);
  return result.plan;
};

// Mirrors crates/nekko-turn/src/plan_update.rs `steps_carry_a_loop_kind_and_count_passes_when_reopened`.
describe('plan step loop kind and passes', () => {
  it('keeps a valid kind, drops an unknown one, and counts a pass each time a finished step is reopened', () => {
    const plan = apply(undefined, { steps: [
      { title: 'Look', kind: 'explore', status: 'done' }, { title: 'Make', kind: 'build', status: 'done' },
      { title: 'Check', kind: 'verify', status: 'active' }, { title: 'Odd', kind: 'deploy' },
    ] });
    expect(plan.map((s) => s.kind)).toEqual(['explore', 'build', 'verify', undefined]);
    expect(Object.keys(plan[1])).toEqual(['id', 'title', 'status', 'kind', 'note', 'createdAt', 'updatedAt']);
    const again = apply(plan, { steps: [{ id: 'step_2', status: 'active' }, { id: 'step_3', status: 'pending' }] });
    expect(again[1].pass).toBe(2);
    expect(again[2].pass).toBeUndefined();
    const done = apply(again, { steps: [{ id: 'step_2', status: 'done' }] });
    expect(done[1].pass).toBe(2);
    expect(apply(done, { steps: [{ id: 'step_2', status: 'active', kind: 'build' }] })[1].pass).toBe(3);
    expect(apply(done, { replace: true, steps: [{ title: 'Make', status: 'active' }] })[1].pass).toBe(2);
  });
});
