import { describe, expect, it } from 'vitest';
import type { PlanStep } from '@nekko-agent/shared';
import type { PlanStepLinks } from './planStepLinks.js';
import { VERIFY_GROUP_ID, groupVerification } from './planVerifyGroup.js';

const step = (id: string, patch: Partial<PlanStep> = {}): PlanStep => ({ id, title: id, status: 'pending', createdAt: 1, updatedAt: 1, ...patch });
const none = new Map<string, PlanStepLinks>();
const linked = (prs: string[]): PlanStepLinks => ({ prs, artifacts: [], projects: [], subagents: [] });

describe('groupVerification', () => {
  it('leaves a plan with one Verify step and no other reports alone', () => {
    const plan = [step('a', { kind: 'build' }), step('v', { kind: 'verify', verification: { status: 'passed' } })];
    const grouped = groupVerification(plan, none);
    expect(grouped.steps).toBe(plan);
    expect(grouped.checks).toEqual([]);
  });

  it('folds several Verify steps into one, where the last one was, with each as a sub-bullet', () => {
    const plan = [
      step('a', { kind: 'build', status: 'done' }),
      step('va', { kind: 'verify', status: 'done', title: 'Test the parser' }),
      step('b', { kind: 'build', status: 'done' }),
      step('vb', { kind: 'verify', status: 'active', title: 'Screenshot the sheet', updatedAt: 5 }),
      step('s', { kind: 'ship' }),
    ];
    const { steps, checks } = groupVerification(plan, none);
    expect(steps.map(s => s.id)).toEqual(['a', 'b', VERIFY_GROUP_ID, 's']);
    expect(steps[2]).toMatchObject({ kind: 'verify', title: 'Check the work', status: 'active', updatedAt: 5 });
    expect(checks.map(s => s.title)).toEqual(['Test the parser', 'Screenshot the sheet']);
  });

  it('moves every other step\'s report under the Verify step, and off that step', () => {
    const plan = [
      step('a', { kind: 'build', status: 'done', title: 'Fix the parser', verification: { status: 'passed', device: 'Windows' } }),
      step('v', { kind: 'verify', status: 'done', title: 'Run the tests' }),
      step('s', { kind: 'ship', status: 'active' }),
    ];
    const { steps, checks } = groupVerification(plan, none);
    expect(steps.map(s => s.id)).toEqual(['a', VERIFY_GROUP_ID, 's']);
    expect(steps[0].verification).toBeUndefined();
    expect(steps[1]).toMatchObject({ title: 'Check the work', status: 'done', verification: { status: 'passed' } });
    expect(checks.map(s => [s.id, s.title, s.status])).toEqual([['a:check', 'Fix the parser', 'done'], ['v', 'Run the tests', 'done']]);
  });

  it('makes a Verify step for reports when the plan has none, before Ship, rolled up from the reports', () => {
    const plan = [
      step('a', { status: 'done', verification: { status: 'passed' } }),
      step('b', { status: 'active', verification: { status: 'failed', detail: 'red' } }),
      step('s', { kind: 'ship' }),
    ];
    const { steps, checks } = groupVerification(plan, none);
    expect(steps.map(s => s.id)).toEqual(['a', 'b', VERIFY_GROUP_ID, 's']);
    // A failing report is the one the folded line shows.
    expect(steps[2]).toMatchObject({ status: 'pending', verification: { status: 'failed' } });
    expect(checks.map(s => s.status)).toEqual(['done', 'pending']);
  });

  it('puts the folded Verify steps\' chips on the one Verify step', () => {
    const plan = [step('v1', { kind: 'verify' }), step('v2', { kind: 'verify' }), step('s', { kind: 'ship' })];
    const links = new Map([['v1', linked(['pr1'])], ['v2', linked(['pr1', 'pr2'])], ['s', linked(['pr3'])]]);
    const grouped = groupVerification(plan, links);
    expect([...grouped.links.keys()]).toEqual(['s', VERIFY_GROUP_ID]);
    expect(grouped.links.get(VERIFY_GROUP_ID)?.prs).toEqual(['pr1', 'pr2']);
  });
});
