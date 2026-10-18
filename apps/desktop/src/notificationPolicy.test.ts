import { describe, expect, it } from 'vitest';
import type { Workflow, WorkflowRun } from '@nekko-agent/shared';
import { decideRunNotice, parseWorkflowRunLink, workflowRunLink } from './notificationPolicy.js';

const wf: Pick<Workflow, 'id' | 'name' | 'notify' | 'steps'> = {
  id: 'w1',
  name: 'Nightly dependency check',
  steps: [
    { id: 'a', name: 'Check for outdated packages', kind: 'shell', run: 'npm outdated' },
    { id: 'b', name: 'Write it up', kind: 'prompt', run: 'Summarize' },
  ],
};
const run = (over: Partial<WorkflowRun>): WorkflowRun => ({ id: 'r1', workflowId: 'w1', status: 'success', triggerKind: 'schedule', startedAt: 1, endedAt: 2, steps: [], ...over });
const ctx = { enabled: true, workflowsVisible: false };
const failed = run({ status: 'failure', steps: [{ stepId: 'a', status: 'failure', attempt: 1, startedAt: 1, error: 'Command failed: npm outdated\nnpm ERR! missing package.json' }] });
const passed = run({ steps: [{ stepId: 'b', status: 'success', attempt: 1, startedAt: 1, output: '\nTwo updates matter: react and vite. ⟦PASS⟧' }] });

describe('workflow run notices', () => {
  it('tells a failure by default, naming the step, and links to the run', () => {
    expect(decideRunNotice(failed, wf, ctx)).toEqual({
      sessionId: 'run:r1',
      kind: 'run-failed',
      title: 'Nightly dependency check failed',
      body: 'At "Check for outdated packages": Command failed: npm outdated',
      link: 'nekko-agent://workflow/run?workflow=w1&run=r1',
    });
    expect(decideRunNotice(run({ status: 'failure', message: 'Interrupted: Nekko Agent stopped.' }), wf, ctx)?.body).toBe('Interrupted: Nekko Agent stopped.');
  });

  it('tells a pass only when the workflow asks for every run', () => {
    expect(decideRunNotice(passed, wf, ctx)).toBeNull();
    expect(decideRunNotice(passed, { ...wf, notify: 'always' }, ctx)).toMatchObject({ kind: 'run-finished', title: 'Nightly dependency check finished', body: 'Two updates matter: react and vite.' });
  });

  it('stays quiet when off, opted out, cancelled, or the Workflows view is on screen', () => {
    expect(decideRunNotice(failed, { ...wf, notify: 'off' }, ctx)).toBeNull();
    expect(decideRunNotice(failed, wf, { ...ctx, enabled: false })).toBeNull();
    expect(decideRunNotice(failed, wf, { ...ctx, workflowsVisible: true })).toBeNull();
    expect(decideRunNotice(run({ status: 'cancelled' }), { ...wf, notify: 'always' }, ctx)).toBeNull();
  });

  it('round-trips run links and refuses anything else', () => {
    expect(parseWorkflowRunLink(workflowRunLink('a b', 'r/1'))).toEqual({ workflowId: 'a b', runId: 'r/1' });
    for (const raw of ['nekko-agent://workflow/run?workflow=w', 'nekko-agent://session/open?id=a', 'https://workflow/run?workflow=w&run=r', 'nope']) {
      expect(parseWorkflowRunLink(raw)).toBeNull();
    }
  });
});
