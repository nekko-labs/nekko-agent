import { expect, it } from 'vitest';
import { applyPlanUpdate, type PlanStep } from './training.js';

const history: PlanStep[] = [
  { id: 'step_1', title: 'Fix parser', status: 'done', note: 'Tests passed', createdAt: 1, updatedAt: 2 },
  { id: 'step_2', title: 'Old pending scope', status: 'pending', createdAt: 1, updatedAt: 1 },
  { id: 'step_3', title: 'Unsupported platform', status: 'skipped', createdAt: 1, updatedAt: 2 },
];

it('keeps settled history when a later request replaces unfinished scope', () => {
  const result = applyPlanUpdate(history, { replace: true, steps: [{ id: 'step_1', title: 'New feature', status: 'active' }] });
  if ('error' in result) throw Error(result.error);
  expect(result.plan.map(s => s.title)).toEqual(['Fix parser', 'Unsupported platform', 'New feature']);
  expect(result.plan[0]).toEqual(history[0]);
  expect(new Set(result.plan.map(s => s.id)).size).toBe(3);
});

it('matches repeated titles without adding duplicates or reopening completed history', () => {
  const result = applyPlanUpdate(history, { replace: true, steps: [{ title: 'FIX PARSER', status: 'pending' }, { title: 'New feature' }] });
  if ('error' in result) throw Error(result.error);
  expect(result.plan).toHaveLength(3);
  expect(result.plan[0].status).toBe('done');
  expect(result.finished).toEqual([]);
  expect(history[0].title).toBe('Fix parser');
});

it('continues existing work by id and appends genuinely new steps without mutating input', () => {
  const result = applyPlanUpdate(history, { steps: [{ id: 'step_2', status: 'done' }, { title: 'New feature' }] });
  if ('error' in result) throw Error(result.error);
  expect(result.plan).toHaveLength(4);
  expect(result.plan[1].status).toBe('done');
  expect(result.finished.map(s => s.id)).toEqual(['step_2']);
  expect(history[1].status).toBe('pending');
});
