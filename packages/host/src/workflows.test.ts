import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { WorkflowStep } from '@nekko-agent/shared';
import { MAX_STEP_LOOPS } from '@nekko-agent/shared';
import { setDataDir } from './paths.js';
import {
  cancelWorkflowRun,
  createWorkflow,
  deleteWorkflow,
  dispatchWorkflowEvent,
  duplicateWorkflow,
  listWorkflowRuns,
  listWorkflows,
  runWorkflow,
  updateWorkflow,
} from './workflows.js';

/**
 * The engine is exercised through shell steps: a command's exit code is the same
 * pass/fail signal an agent step reports with its token, so the routing, retry,
 * and loop-cap behaviour under test is identical without needing a live model.
 */
// A shell builtin, the same on cmd.exe and sh, so a step costs one shell start
// rather than a shell plus a node start.
const pass = (): string => 'exit 0';
const fail = (): string => 'exit 1';

function shell(id: string, command: string, over: Partial<WorkflowStep> = {}): WorkflowStep {
  return { id, name: id, kind: 'shell', run: command, ...over };
}

/** Step ids in the order the run actually visited them. */
function visited(runId: string): string[] {
  const run = listWorkflowRuns().find((r) => r.id === runId)!;
  return run.steps.map((s) => s.stepId);
}

let dir = '';

beforeEach(() => {
  // A fresh data dir per test, so workflows.json and workflow-runs.json start empty.
  dir = mkdtempSync(join(tmpdir(), 'nekko-workflows-'));
  setDataDir(dir);
});

/**
 * A command that fails the first time and passes afterwards, by leaving a marker
 * behind. Forward slashes so the path is a valid JS string literal on Windows too.
 */
function failThenPass(marker: string): string {
  const path = join(dir, marker).replace(/\\/g, '/');
  return `node -e "const f=require('fs'),p='${path}'; if (f.existsSync(p)) process.exit(0); f.writeFileSync(p,'1'); process.exit(1)"`;
}

describe('workflow CRUD', () => {
  it('creates with sane defaults and lists it back', () => {
    const wf = createWorkflow({ name: '  Nightly sweep  ' });
    expect(wf.name).toBe('Nightly sweep');
    expect(wf.enabled).toBe(true);
    expect(wf.category).toBe('Uncategorized');
    expect(wf.triggers).toHaveLength(1);
    expect(listWorkflows().map((w) => w.id)).toEqual([wf.id]);
  });

  it('refuses to let a patch move the identity fields', () => {
    const wf = createWorkflow({ name: 'A' });
    const patched = updateWorkflow(wf.id, { id: 'hacked', createdAt: 0, name: 'B' } as never)!;
    expect(patched.id).toBe(wf.id);
    expect(patched.createdAt).toBe(wf.createdAt);
    expect(patched.name).toBe('B');
  });

  it('duplicates a workflow disabled, with fresh trigger ids', () => {
    const wf = createWorkflow({ name: 'Review PRs', triggers: [{ id: 't1', kind: 'git', events: ['pr_opened'] }] });
    const copy = duplicateWorkflow(wf.id)!;
    expect(copy.name).toBe('Review PRs (copy)');
    expect(copy.enabled).toBe(false);
    expect(copy.triggers[0].id).not.toBe('t1');
    expect(copy.triggers[0].events).toEqual(['pr_opened']);
  });

  it('deleting a workflow takes its run history with it', async () => {
    const wf = createWorkflow({ name: 'X', steps: [shell('a', pass())] });
    await runWorkflow(wf.id);
    expect(listWorkflowRuns()).toHaveLength(1);
    deleteWorkflow(wf.id);
    expect(listWorkflows()).toEqual([]);
    expect(listWorkflowRuns()).toEqual([]);
  });

  it('reports the next scheduled fire on the list', () => {
    const wf = createWorkflow({ name: 'Cron', triggers: [{ id: 't', kind: 'schedule', cron: '0 3 * * *' }] });
    expect(listWorkflows().find((w) => w.id === wf.id)!.nextRunAt).toBeGreaterThan(Date.now());
    updateWorkflow(wf.id, { enabled: false });
    // A disabled workflow shows no next run, because it won't have one.
    expect(listWorkflows().find((w) => w.id === wf.id)!.nextRunAt).toBeUndefined();
  });
});

describe('running a workflow', () => {
  it('walks the steps in order and succeeds', async () => {
    const wf = createWorkflow({ name: 'Ordered', steps: [shell('one', pass()), shell('two', pass())] });
    const run = (await runWorkflow(wf.id))!;
    expect(run.status).toBe('success');
    expect(visited(run.id)).toEqual(['one', 'two']);
    expect(run.steps.every((s) => s.status === 'success')).toBe(true);
  });

  it('captures command output on the step', async () => {
    const wf = createWorkflow({ name: 'Talks', steps: [shell('say', `node -e "console.log('hello from the step')"`)] });
    const run = (await runWorkflow(wf.id))!;
    expect(run.steps[0].output).toContain('hello from the step');
  });

  it('fails the run at a failing step, and says which one', async () => {
    const wf = createWorkflow({ name: 'Breaks', steps: [shell('ok', pass()), shell('boom', fail()), shell('never', pass())] });
    const run = (await runWorkflow(wf.id))!;
    expect(run.status).toBe('failure');
    expect(run.message).toContain('"boom" failed');
    expect(visited(run.id)).toEqual(['ok', 'boom']); // the third step never ran
  });

  it('carries on past a failing step marked continue-on-error', async () => {
    const wf = createWorkflow({
      name: 'Tolerant',
      steps: [shell('flaky', fail(), { continueOnError: true }), shell('after', pass())],
    });
    const run = (await runWorkflow(wf.id))!;
    expect(run.status).toBe('success');
    expect(visited(run.id)).toEqual(['flaky', 'after']);
    // The failure is still recorded honestly, it just didn't stop the run.
    expect(run.steps[0].status).toBe('failure');
  });

  it('retries a failing step the requested number of times', async () => {
    const wf = createWorkflow({ name: 'Retries', steps: [shell('tries', fail(), { retries: 2 })] });
    const run = (await runWorkflow(wf.id))!;
    expect(run.status).toBe('failure');
    // Three attempts: the first plus two retries.
    expect(run.steps.map((s) => s.attempt)).toEqual([1, 2, 3]);
  });

  it('stops retrying as soon as an attempt passes', async () => {
    const wf = createWorkflow({ name: 'Recovers', steps: [shell('tries', pass(), { retries: 3 })] });
    const run = (await runWorkflow(wf.id))!;
    expect(run.steps).toHaveLength(1);
    expect(run.status).toBe('success');
  });

  it('routes a failure back to an earlier step, and bounds the loop', async () => {
    // The headline case: verify never passes, so it keeps sending the run back to
    // build. Without a cap this would never end.
    const wf = createWorkflow({
      name: 'Build and verify',
      steps: [shell('build', pass()), shell('verify', fail(), { onFailure: { goto: 'step', stepId: 'build' } })],
    });
    const run = (await runWorkflow(wf.id))!;
    expect(run.status).toBe('failure');
    expect(run.message).toContain(`${MAX_STEP_LOOPS} times`);
    const buildVisits = visited(run.id).filter((id) => id === 'build').length;
    expect(buildVisits).toBe(MAX_STEP_LOOPS);
  });

  it('converges when a loop-back step eventually passes', async () => {
    // build → verify (fails) → build → verify (passes). The realistic shape: the
    // second pass through build fixed whatever verify was complaining about.
    const wf = createWorkflow({
      name: 'Converges',
      steps: [
        shell('build', pass()),
        shell('verify', failThenPass('verified'), { onFailure: { goto: 'step', stepId: 'build' } }),
      ],
    });
    const run = (await runWorkflow(wf.id))!;
    expect(run.status).toBe('success');
    expect(visited(run.id)).toEqual(['build', 'verify', 'build', 'verify']);
  });

  it('ends the run when a transition points at a deleted step', async () => {
    const wf = createWorkflow({
      name: 'Dangling',
      steps: [shell('a', pass(), { onSuccess: { goto: 'step', stepId: 'ghost' } })],
    });
    const run = (await runWorkflow(wf.id))!;
    expect(run.status).toBe('failure');
    expect(run.message).toContain('no longer exists');
  });

  it('honours an explicit end transition', async () => {
    const wf = createWorkflow({
      name: 'Early out',
      steps: [shell('a', pass(), { onSuccess: { goto: 'end' } }), shell('b', fail())],
    });
    const run = (await runWorkflow(wf.id))!;
    expect(run.status).toBe('success');
    expect(visited(run.id)).toEqual(['a']);
  });

  it('does not start a workflow with no steps', async () => {
    const wf = createWorkflow({ name: 'Empty', steps: [] });
    expect(await runWorkflow(wf.id)).toBeUndefined();
    expect(listWorkflowRuns()).toEqual([]);
  });

  it('times a step out instead of hanging on it', async () => {
    const wf = createWorkflow({
      name: 'Slow',
      steps: [shell('sleeps', `node -e "setTimeout(()=>{}, 30000)"`, { timeoutSec: 1 })],
    });
    const run = (await runWorkflow(wf.id))!;
    expect(run.status).toBe('failure');
    expect(run.steps[0].error).toContain('Timed out');
  }, 20_000);

  it('records the trigger that started it', async () => {
    const wf = createWorkflow({
      name: 'Reviewer',
      steps: [shell('a', pass())],
      triggers: [{ id: 't', kind: 'git', provider: 'github', events: ['pr_opened'] }],
    });
    const [run] = await dispatchWorkflowEvent({
      kind: 'git', provider: 'github', event: 'pr_opened', repo: 'nekko-labs/nekko-agent', branch: 'main',
    });
    expect(run.workflowId).toBe(wf.id);
    expect(run.triggerKind).toBe('git');
    expect(run.triggerLabel).toContain('pr_opened');
  });

  it('ignores an event no workflow listens for', async () => {
    createWorkflow({ name: 'Manual only', steps: [shell('a', pass())] });
    expect(await dispatchWorkflowEvent({ kind: 'git', provider: 'github', event: 'pr_opened' })).toEqual([]);
  });

  it('rolls the outcome up onto the workflow for the list row', async () => {
    const wf = createWorkflow({ name: 'Rollup', steps: [shell('a', fail())] });
    await runWorkflow(wf.id);
    const after = listWorkflows().find((w) => w.id === wf.id)!;
    expect(after.lastStatus).toBe('failure');
    expect(after.runCount).toBe(1);
    expect(after.lastRunAt).toBeGreaterThan(0);
  });

  it('refuses a nested workflow that would recurse forever', async () => {
    const inner = createWorkflow({ name: 'Inner', steps: [shell('a', pass())] });
    // Point the workflow at itself: depth, not cycle detection, is what stops it.
    updateWorkflow(inner.id, { steps: [{ id: 's', name: 'self', kind: 'workflow', run: inner.id }] });
    const run = (await runWorkflow(inner.id))!;
    expect(run.status).toBe('failure');
  });

  it('runs a nested workflow and inherits its result', async () => {
    const inner = createWorkflow({ name: 'Inner', steps: [shell('a', fail())] });
    const outer = createWorkflow({
      name: 'Outer',
      steps: [{ id: 'call', name: 'call inner', kind: 'workflow', run: inner.id }],
    });
    const run = (await runWorkflow(outer.id))!;
    expect(run.status).toBe('failure');
    expect(run.steps[0].error).toBeTruthy();
  });

  it('reports a nested step whose target was deleted', async () => {
    const outer = createWorkflow({
      name: 'Outer',
      steps: [{ id: 'call', name: 'call missing', kind: 'workflow', run: 'does-not-exist' }],
    });
    const run = (await runWorkflow(outer.id))!;
    expect(run.status).toBe('failure');
    expect(run.steps[0].error).toContain('no longer exists');
  });

  it('trims history to the most recent runs per workflow', async () => {
    const wf = createWorkflow({ name: 'Chatty', steps: [shell('a', pass())] });
    for (let i = 0; i < 24; i++) await runWorkflow(wf.id);
    expect(listWorkflowRuns(wf.id).length).toBeLessThanOrEqual(20);
  });

  it('cancelling a finished run changes nothing', async () => {
    const wf = createWorkflow({ name: 'Done', steps: [shell('a', pass())] });
    const run = (await runWorkflow(wf.id))!;
    cancelWorkflowRun(run.id);
    expect(listWorkflowRuns().find((r) => r.id === run.id)!.status).toBe('success');
  });
});
