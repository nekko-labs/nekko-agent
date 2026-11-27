import { describe, expect, it } from 'vitest';
import type { PlanStep } from '@nekko-agent/shared';
import { planRows } from './planDisplay.js';
const step = (id: string, status: PlanStep['status']): PlanStep => ({ id, title: id, status, createdAt: 0, updatedAt: 1 });
describe('compact plan progress', () => {
  it('prioritizes active work, fills vacancies as work finishes and preserves full plan order', () => {
    const steps = [step('a','pending'),step('b','active'),step('c','pending'),step('d','skipped'),step('e','pending')];
    const ids = (full: boolean) => planRows(steps, full, 'balanced').visible.map(s => s.id);
    expect(ids(false)).toEqual(['b','a','c']);
    expect(ids(true)).toEqual(['a','b','c','e']);
    expect(planRows(steps,false,'one').visible).toEqual([steps[1]]);
    steps[1].status = 'done';
    expect(ids(false)).toEqual(['a','c','e']);
    expect(planRows(steps,false,'one').completed).toEqual([steps[1],steps[3]]);
    steps.forEach(s => { s.status = 'done'; });
    expect(planRows(steps,false,'balanced')).toEqual({ visible: [], completed: steps });
  });
});
