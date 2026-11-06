import { expect, it, vi } from 'vitest';
import { applyPlanUpdate, type PlanStep, type PlanUpdateInput } from './training.js';

function apply(current: PlanStep[] | undefined, input: PlanUpdateInput) {
  const result = applyPlanUpdate(current, input);
  if ('error' in result) throw Error(result.error);
  return result;
}

it('persists explicit verification independently of done and uses step freshness', () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(10);
  try {
    const initial = apply(undefined, { steps: [{ title: 'Inspect phone', status: 'done', verification: { status: 'active', device: ' phone ', detail: ' inspecting ' } }] });
    expect(initial.plan[0].verification).toEqual({ status: 'active', device: 'phone', detail: 'inspecting' });
    clock.mockReturnValue(20);
    const passed = apply(initial.plan, { steps: [{ id: 'step_1', verification: { status: 'passed', evidenceUrl: 'https://example.com/proof' } }] });
    expect(passed.plan[0]).toMatchObject({ status: 'done', createdAt: 10, updatedAt: 20, verification: { status: 'passed', evidenceUrl: 'https://example.com/proof' } });
    expect(initial.plan[0].verification?.status).toBe('active');
    expect(passed.finished).toEqual([]);
    const retained = apply(passed.plan, { replace: true, steps: [{ title: 'Next task' }] });
    expect(retained.plan[0]).toEqual(passed.plan[0]);
    expect(apply(passed.plan, { steps: [{ id: 'step_1', verification: { status: 'done' } }] }).plan[0].verification).toEqual(passed.plan[0].verification);
  } finally { clock.mockRestore(); }
});

it('accepts all explicit states and never infers verification from done', () => {
  for (const status of ['pending', 'active', 'passed', 'failed', 'blocked', 'unknown']) {
    expect(apply(undefined, { steps: [{ title: status, verification: { status } }] }).plan[0].verification?.status).toBe(status);
  }
  const result = apply(undefined, { steps: [{ title: 'Build', status: 'done' }] });
  expect(result.plan[0]).not.toHaveProperty('verification');
});

it('ignores invalid metadata and bounds text without truncating evidence links', () => {
  for (const verification of [null, [], 'passed', {}, { status: 'DONE' }]) {
    expect(apply(undefined, { steps: [{ title: 'Check', verification }] }).plan[0]).not.toHaveProperty('verification');
  }
  for (const evidenceUrl of ['file:///tmp/proof', 'javascript:alert(1)', 'https://user:secret@example.com', 'https://example.com/' + 'a'.repeat(2048), 'https://', 123]) {
    const result = apply(undefined, { steps: [{ title: 'Check', verification: { status: 'unknown', device: 'x'.repeat(200), detail: 'y'.repeat(1100), evidenceUrl } }] });
    expect(result.plan[0].verification).toEqual({ status: 'unknown', device: 'x'.repeat(160), detail: 'y'.repeat(1000) });
  }
});
