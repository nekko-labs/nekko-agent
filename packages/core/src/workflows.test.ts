import { describe, expect, it } from 'vitest';
import {
  MAX_STEP_LOOPS,
  WORKFLOW_TEMPLATES,
  branchMatches,
  cliCommand,
  cronMatches,
  filterWorkflows,
  groupWorkflows,
  isValidCron,
  listenerKeys,
  matchWorkflows,
  nextCronRun,
  nextScheduledRun,
  dailyCron,
  pausedBlocks,
  runOutcome,
  slugify,
  templateInputProblem,
  templateInputValues,
  templateReadiness,
  weekdayCron,
  triggerAccepts,
  triggerLabel,
  unreachableSteps,
  workflowEdges,
} from '@nekko-agent/shared';
import type { ConnectorKind, Workflow, WorkflowEvent, WorkflowStep, WorkflowTrigger } from '@nekko-agent/shared';

function step(id: string, over: Partial<WorkflowStep> = {}): WorkflowStep {
  return { id, name: id, kind: 'prompt', run: `do ${id}`, ...over };
}

function wf(over: Partial<Workflow> = {}): Workflow {
  return {
    id: over.id ?? 'w1',
    name: over.name ?? 'Build and verify',
    category: over.category ?? 'Build & test',
    enabled: over.enabled ?? true,
    steps: over.steps ?? [step('a'), step('b')],
    triggers: over.triggers ?? [{ id: 't1', kind: 'manual' }],
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

describe('slugify + cliCommand', () => {
  it('makes a command-line-safe name', () => {
    expect(slugify('Build, then verify (loops back)')).toBe('build-then-verify-loops-back');
    expect(slugify('!!!')).toBe('workflow');
    expect(slugify('  padded  ')).toBe('padded');
    expect(slugify('--dashes--everywhere--')).toBe('dashes-everywhere');
  });

  it('never leaves a trailing separator, whatever the 48-char cut lands on', () => {
    // "aaaa-bbbb-…" cut mid-run vs cut exactly on a separator.
    for (let i = 1; i < 60; i++) {
      const slug = slugify(Array.from({ length: i }, (_, n) => `word${n}`).join(' '));
      expect(slug.endsWith('-'), `length ${i}`).toBe(false);
      expect(slug.length).toBeLessThanOrEqual(48);
    }
  });

  it('slugs a pathological name in linear time', () => {
    // The ReDoS shape: a name that is almost entirely separators. The old
    // replace-then-trim (/^-+|-+$/) backtracked quadratically on this.
    const start = Date.now();
    expect(slugify(`${'-'.repeat(50_000)}x`)).toBe('x');
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  it('falls back to the workflow slug when a CLI trigger names nothing', () => {
    const w = wf({ name: 'Nightly Sweep' });
    expect(cliCommand(w, { id: 't', kind: 'cli' })).toBe('nightly-sweep');
    expect(cliCommand(w, { id: 't', kind: 'cli', command: 'sweep' })).toBe('sweep');
  });
});

describe('workflowEdges', () => {
  it('falls through to the next step, then ends', () => {
    const edges = workflowEdges([step('a'), step('b')]);
    expect(edges.filter((e) => e.kind === 'success')).toEqual([
      { from: 'a', to: 'b', kind: 'success', back: false },
      { from: 'b', to: 'end', kind: 'success', back: false },
    ]);
  });

  it('marks a jump to an earlier step as a loop back', () => {
    // The headline case: verify fails, so the run returns to build.
    const steps = [step('build'), step('verify', { onFailure: { goto: 'step', stepId: 'build' } })];
    const back = workflowEdges(steps).find((e) => e.kind === 'failure')!;
    expect(back).toEqual({ from: 'verify', to: 'build', kind: 'failure', back: true });
  });

  it('does not draw a failure edge that just stops the run', () => {
    expect(workflowEdges([step('a')]).filter((e) => e.kind === 'failure')).toEqual([]);
  });

  it('draws continue-on-error as a failure edge to the next step', () => {
    const edges = workflowEdges([step('a', { continueOnError: true }), step('b')]);
    expect(edges).toContainEqual({ from: 'a', to: 'b', kind: 'failure', back: false });
  });

  it('treats a jump to a deleted step as ending the run', () => {
    const edges = workflowEdges([step('a', { onSuccess: { goto: 'step', stepId: 'gone' } })]);
    expect(edges[0].to).toBe('end');
  });
});

describe('unreachableSteps', () => {
  it('finds a step nothing routes to', () => {
    // a ends the run, so b can never run.
    const steps = [step('a', { onSuccess: { goto: 'end' } }), step('b')];
    expect(unreachableSteps(steps)).toEqual(['b']);
  });

  it('counts a step reachable only through a loop back', () => {
    const steps = [step('a'), step('b', { onFailure: { goto: 'step', stepId: 'a' } })];
    expect(unreachableSteps(steps)).toEqual([]);
  });
});

describe('grouping and filtering', () => {
  const list = [
    wf({ id: '1', name: 'Alpha', category: 'Release', triggers: [{ id: 't', kind: 'schedule', cron: '0 3 * * *' }] }),
    wf({ id: '2', name: 'Beta', category: 'Release', triggers: [{ id: 't', kind: 'manual' }] }),
    wf({
      id: '3',
      name: 'Gamma',
      category: 'Code review',
      enabled: false,
      triggers: [{ id: 't', kind: 'git', provider: 'gitlab', events: ['pr_opened', 'pr_comment'] }],
    }),
  ];

  it('groups by category, biggest group first, names alphabetical', () => {
    const groups = groupWorkflows(list, 'category');
    expect(groups.map((g) => g.label)).toEqual(['Release', 'Code review']);
    expect(groups[0].workflows.map((w) => w.name)).toEqual(['Alpha', 'Beta']);
  });

  it('lists a workflow under every event it listens for', () => {
    const groups = groupWorkflows(list, 'listener');
    expect(groups.map((g) => g.label).sort()).toEqual([
      'GitLab · PR comment',
      'GitLab · PR opened',
      'Manual',
      'Schedule',
    ]);
  });

  it('searches name, category, and step bodies', () => {
    expect(filterWorkflows(list, { query: 'gamma' }).map((w) => w.id)).toEqual(['3']);
    expect(filterWorkflows(list, { query: 'do a' })).toHaveLength(3); // every step body
    expect(filterWorkflows(list, { query: 'nothing here' })).toEqual([]);
  });

  it('filters by category, state, and trigger kind together', () => {
    expect(filterWorkflows(list, { category: 'Release' }).map((w) => w.id)).toEqual(['1', '2']);
    expect(filterWorkflows(list, { state: 'disabled' }).map((w) => w.id)).toEqual(['3']);
    expect(filterWorkflows(list, { triggerKind: 'git' }).map((w) => w.id)).toEqual(['3']);
    expect(filterWorkflows(list, { category: 'Release', triggerKind: 'git' })).toEqual([]);
  });

  it('treats a workflow with no armed trigger as manual', () => {
    expect(listenerKeys(wf({ triggers: [{ id: 't', kind: 'schedule', enabled: false }] }))).toEqual(['manual']);
  });
});

describe('trigger labels', () => {
  it('says when each kind fires', () => {
    const w = wf({ name: 'Nightly' });
    expect(triggerLabel({ id: 't', kind: 'schedule', cron: '0 9 * * 1' }, w)).toBe('Cron 0 9 * * 1');
    expect(triggerLabel({ id: 't', kind: 'schedule', intervalMs: 900_000 }, w)).toBe('Every 15 min');
    expect(triggerLabel({ id: 't', kind: 'cli' }, w)).toBe('CLI: nightly');
    expect(triggerLabel({ id: 't', kind: 'slack', channel: '#builds', keyword: 'deploy' }, w)).toBe('Slack #builds · "deploy"');
    expect(triggerLabel({ id: 't', kind: 'git', provider: 'bitbucket', events: ['pr_merged'], repo: 'me/app' }, w)).toBe(
      'Bitbucket: PR merged · me/app',
    );
  });
});

describe('event matching', () => {
  const prTrigger: WorkflowTrigger = {
    id: 't',
    kind: 'git',
    provider: 'github',
    events: ['pr_opened'],
    repo: 'nekko-labs/nekko-agent',
    branches: ['main', 'release/*'],
  };
  const reviewer = wf({ id: 'r', triggers: [prTrigger] });

  it('accepts the event it was configured for', () => {
    expect(triggerAccepts(reviewer, prTrigger, {
      kind: 'git', provider: 'github', event: 'pr_opened', repo: 'nekko-labs/nekko-agent', branch: 'main',
    })).toBe(true);
  });

  it('rejects the wrong provider, event, repo, or branch', () => {
    const base = { kind: 'git' as const, provider: 'github' as const, event: 'pr_opened' as const, repo: 'nekko-labs/nekko-agent', branch: 'main' };
    expect(triggerAccepts(reviewer, prTrigger, { ...base, provider: 'gitlab' })).toBe(false);
    expect(triggerAccepts(reviewer, prTrigger, { ...base, event: 'pr_closed' })).toBe(false);
    expect(triggerAccepts(reviewer, prTrigger, { ...base, repo: 'someone/else' })).toBe(false);
    expect(triggerAccepts(reviewer, prTrigger, { ...base, branch: 'feature/x' })).toBe(false);
    expect(triggerAccepts(reviewer, prTrigger, { ...base, branch: 'release/5' })).toBe(true);
  });

  it('never starts a disabled workflow', () => {
    const off = wf({ id: 'off', enabled: false, triggers: [prTrigger] });
    const event = { kind: 'git' as const, provider: 'github' as const, event: 'pr_opened' as const, repo: 'nekko-labs/nekko-agent', branch: 'main' };
    expect(matchWorkflows([off, reviewer], event).map((w) => w.id)).toEqual(['r']);
  });

  it('matches a CLI invocation by command name', () => {
    const cli = wf({ id: 'c', name: 'Deploy Staging', triggers: [{ id: 't', kind: 'cli' }] });
    expect(matchWorkflows([cli], { kind: 'cli', command: 'deploy-staging' }).map((w) => w.id)).toEqual(['c']);
    expect(matchWorkflows([cli], { kind: 'cli', command: 'something-else' })).toEqual([]);
  });

  it('matches a Slack message by channel and keyword', () => {
    const slack = wf({ id: 's', triggers: [{ id: 't', kind: 'slack', channel: 'builds', keyword: 'ship it' }] });
    expect(matchWorkflows([slack], { kind: 'slack', channel: '#builds', text: 'ok SHIP IT' })).toHaveLength(1);
    expect(matchWorkflows([slack], { kind: 'slack', channel: '#builds', text: 'not yet' })).toEqual([]);
    expect(matchWorkflows([slack], { kind: 'slack', channel: '#random', text: 'ship it' })).toEqual([]);
  });
});

describe('branchMatches', () => {
  it('matches exactly, or by glob, and accepts anything when unset', () => {
    expect(branchMatches('main', undefined)).toBe(true);
    expect(branchMatches('main', ['main'])).toBe(true);
    expect(branchMatches('main', ['develop'])).toBe(false);
    expect(branchMatches('release/1.2', ['release/*'])).toBe(true);
    expect(branchMatches('releases/1.2', ['release/*'])).toBe(false);
    expect(branchMatches('feat.x', ['feat.*'])).toBe(true);
    expect(branchMatches('featux', ['feat.*'])).toBe(false); // the dot is literal
  });
});

describe('cron', () => {
  it('accepts the forms a schedule needs and rejects nonsense', () => {
    for (const ok of ['* * * * *', '0 3 * * *', '*/15 * * * *', '0 9-17 * * 1-5', '0 0 1,15 * *']) {
      expect(isValidCron(ok), ok).toBe(true);
    }
    for (const bad of ['', '* * * *', '60 * * * *', '0 24 * * *', '0 0 0 * *', 'x * * * *', '*/0 * * * *', '5-1 * * * *']) {
      expect(isValidCron(bad), bad).toBe(false);
    }
  });

  it('matches a daily time', () => {
    expect(cronMatches('0 3 * * *', new Date(2026, 7, 13, 3, 0))).toBe(true);
    expect(cronMatches('0 3 * * *', new Date(2026, 7, 13, 3, 1))).toBe(false);
    expect(cronMatches('0 3 * * *', new Date(2026, 7, 13, 4, 0))).toBe(false);
  });

  it('matches a step field', () => {
    expect(cronMatches('*/15 * * * *', new Date(2026, 7, 13, 9, 30))).toBe(true);
    expect(cronMatches('*/15 * * * *', new Date(2026, 7, 13, 9, 31))).toBe(false);
  });

  it('ORs day-of-month with day-of-week when both are restricted (Vixie cron)', () => {
    // The 1st, or any Monday. 2026-08-13 is a Thursday, so neither.
    expect(cronMatches('0 0 1 * 1', new Date(2026, 7, 1, 0, 0))).toBe(true);
    expect(cronMatches('0 0 1 * 1', new Date(2026, 7, 10, 0, 0))).toBe(true); // a Monday
    expect(cronMatches('0 0 1 * 1', new Date(2026, 7, 13, 0, 0))).toBe(false);
  });

  it('finds the next run strictly after the moment given', () => {
    const from = new Date(2026, 7, 13, 3, 0, 30);
    expect(new Date(nextCronRun('0 3 * * *', from)!)).toEqual(new Date(2026, 7, 14, 3, 0));
    expect(new Date(nextCronRun('*/15 * * * *', new Date(2026, 7, 13, 9, 5))!)).toEqual(new Date(2026, 7, 13, 9, 15));
  });

  it('gives up on a date that never comes', () => {
    expect(nextCronRun('0 0 30 2 *')).toBeUndefined(); // February 30th
  });

  it('picks the earliest of several schedules', () => {
    const now = new Date(2026, 7, 13, 9, 0).getTime();
    const w = wf({
      triggers: [
        { id: 'a', kind: 'schedule', cron: '0 3 * * *' },
        { id: 'b', kind: 'schedule', cron: '30 9 * * *' },
        { id: 'c', kind: 'schedule', cron: '0 10 * * *', enabled: false },
      ],
    });
    expect(new Date(nextScheduledRun(w, now)!)).toEqual(new Date(2026, 7, 13, 9, 30));
  });

  it('has no next run without a schedule trigger', () => {
    expect(nextScheduledRun(wf())).toBeUndefined();
  });
});

describe('templates', () => {
  it('all build a runnable workflow', () => {
    for (const t of WORKFLOW_TEMPLATES) {
      const { steps, triggers } = t.build();
      expect(steps.length, t.id).toBeGreaterThan(0);
      expect(triggers.length, t.id).toBeGreaterThan(0);
      expect(new Set(steps.map((s) => s.id)).size, t.id).toBe(steps.length); // ids unique
      expect(unreachableSteps(steps), t.id).toEqual([]);
    }
  });

  it('the build/verify template really loops back', () => {
    const { steps } = WORKFLOW_TEMPLATES.find((t) => t.id === 'build-verify-loop')!.build();
    expect(workflowEdges(steps).some((e) => e.back)).toBe(true);
    expect(MAX_STEP_LOOPS).toBeGreaterThan(1);
  });

  it('the local CI runner template wires trigger → build → status → comment', () => {
    const { steps, triggers } = WORKFLOW_TEMPLATES.find((t) => t.id === 'local-ci-runner')!.build();
    // An armed git trigger on push/PR events.
    const git = triggers.find((t) => t.kind === 'git');
    expect(git?.provider).toBe('github');
    expect(git?.events).toEqual(expect.arrayContaining(['push', 'pr_opened']));
    // Poll and webhook modes ship as disarmed starters — arming both (or with
    // the git trigger) would double-fire.
    const starters = triggers.filter((t) => t.kind !== 'git');
    expect(starters.map((t) => t.kind).sort()).toEqual(['connector', 'webhook']);
    for (const s of starters) expect(s.enabled, s.kind).toBe(false);
    expect(starters.find((t) => t.kind === 'webhook')?.webhookSecret).toBeTruthy();
    // Two shell steps to edit, two status reporters, one commenter.
    const kinds = steps.map((s) => `${s.kind}:${s.kind === 'action' ? s.run : ''}`);
    expect(kinds.filter((k) => k.startsWith('shell')).length).toBe(2);
    expect(kinds.filter((k) => k === 'action:github.setCommitStatus').length).toBe(2);
    expect(kinds).toContain('action:github.commentPR');
    // Failure paths route to the failure reporter; the success reporter ends the run.
    const test = steps.find((s) => s.name.toLowerCase().includes('build'))!;
    const failStep = steps.find((s) => s.name.toLowerCase().includes('failure'))!;
    expect(test.onFailure).toEqual({ goto: 'step', stepId: failStep.id });
    const okStep = steps.find((s) => s.name.toLowerCase().includes('success'))!;
    expect(okStep.onSuccess).toEqual({ goto: 'end' });
  });
});

describe('gallery templates', () => {
  const byId = (id: string) => WORKFLOW_TEMPLATES.find((t) => t.id === id)!;
  const env = { connectors: [], defaultProviderId: 'p', defaultModelId: 'm' };

  it('build from their inputs, with valid schedules', () => {
    for (const t of WORKFLOW_TEMPLATES.filter((x) => x.featured)) {
      const { steps, triggers } = t.build(templateInputValues(t, { repo: 'o/r' }));
      expect(steps.length, t.id).toBeGreaterThan(0);
      expect(t.summary, t.id).toBeTruthy();
      for (const trig of triggers.filter((x) => x.kind === 'schedule')) expect(isValidCron(trig.cron!), t.id).toBe(true);
    }
  });

  it('turns a time input into the schedule', () => {
    expect(weekdayCron('08:30')).toBe('30 8 * * 1-5');
    expect(dailyCron('3:05')).toBe('5 3 * * *');
    expect(weekdayCron('25:00')).toBeUndefined();
    expect(byId('github-notifications').build({ time: '07:15' }).triggers[0].cron).toBe('15 7 * * 1-5');
  });

  it('keeps the PR watcher disarmed until it has a repo and an author', () => {
    const t = byId('review-my-prs');
    expect(t.build({}).triggers[0].enabled).toBe(false);
    expect(t.build({ repo: 'o/r' }).triggers[0].enabled).toBe(false);
    expect(t.build({ author: 'octo' }).triggers[0].enabled).toBe(false);
    const armed = t.build({ repo: 'o/r', author: ' octo ' });
    expect(armed.triggers[0]).toMatchObject({ kind: 'connector', connector: 'github', repo: 'o/r', action: 'opened', actor: 'octo', enabled: true });
    expect(armed.triggers[0].filter).toBeUndefined();
  });

  it('starts the PR review only for PRs the author opens', () => {
    const reviewer = wf({ id: 'r', ...byId('review-my-prs').build({ repo: 'o/r', author: 'octo' }) });
    const opened: WorkflowEvent = { kind: 'connector', connector: 'github', event: 'PullRequestEvent', actor: 'Octo', payload: { action: 'opened', number: 1 } };
    expect(matchWorkflows([reviewer], opened).map((w) => w.id)).toEqual(['r']);
    expect(matchWorkflows([reviewer], { ...opened, payload: { action: 'reopened' } })).toEqual([]);
    expect(matchWorkflows([reviewer], { ...opened, payload: { action: 'closed', title: 'opened' } })).toEqual([]);
    expect(matchWorkflows([reviewer], { ...opened, actor: 'mallory' })).toEqual([]);
    expect(matchWorkflows([reviewer], { ...opened, actor: undefined })).toEqual([]);
  });

  it('checks inputs', () => {
    const [repo, author] = byId('review-my-prs').inputs!;
    expect(templateInputProblem(repo, '')).toMatch(/required/);
    expect(templateInputProblem(repo, 'nope')).toMatch(/owner\/name/);
    expect(templateInputProblem(repo, 'o/r')).toBeUndefined();
    expect(templateInputProblem(author, '')).toMatch(/required/);
    expect(templateInputProblem(byId('github-notifications').inputs![0], '9am')).toMatch(/time/);
  });

  it('reports each requirement and whether it is met', () => {
    expect(templateReadiness(byId('github-notifications'), env).map((n) => [n.id, n.ok])).toEqual([
      ['connector:github', false],
      ['model', true],
    ]);
    const either = { ...byId('github-notifications'), requires: { anyConnector: ['linear', 'jira'] as ConnectorKind[] } };
    const digest = templateReadiness(either, { ...env, connectors: [{ kind: 'jira', connected: true }] });
    expect(digest[0]).toMatchObject({ label: 'Linear or Jira connected', ok: true, fix: 'connectors' });
    const nightly = templateReadiness(byId('nightly-dependency-check'), { connectors: [] });
    expect(nightly.map((n) => [n.id, n.ok])).toEqual([['workspace', false], ['model', false]]);
  });

  it('never hands text someone else wrote to an agent with tools', () => {
    expect(WORKFLOW_TEMPLATES.find((t) => t.id === 'ticket-digest')).toBeUndefined();
    for (const id of ['github-notifications', 'nightly-dependency-check']) {
      const { steps } = byId(id).build(templateInputValues(byId(id), {}));
      const agents = steps.filter((s) => s.kind === 'prompt' || s.kind === 'skill');
      // One agent step, last, tools off, quoting the earlier fetch steps' output.
      expect(agents.map((s) => s.id), id).toEqual([steps[steps.length - 1].id]);
      expect(agents[0].tools, id).toBe('none');
      for (const fetch of steps.slice(0, -1)) {
        expect(fetch.kind, id).toBe('shell');
        expect(agents[0].run, id).toContain(`{{steps.${fetch.id}.output}}`);
      }
    }
  });
});

describe('pause all automations', () => {
  it('holds back what nobody started by hand', () => {
    for (const kind of ['schedule', 'git', 'slack', 'connector', 'webhook'] as const) expect(pausedBlocks(kind, true), kind).toBe(true);
    expect(pausedBlocks('manual', true)).toBe(false);
    expect(pausedBlocks('cli', true)).toBe(false);
    expect(pausedBlocks('schedule', false)).toBe(false);
    expect(pausedBlocks('schedule', undefined)).toBe(false);
  });
});

describe('run outcomes', () => {
  const steps = [step('a', { name: 'Check' }), step('b', { kind: 'shell', name: 'Lint' }), step('c', { name: 'Write up' })];
  const run = (status: 'success' | 'failure' | 'cancelled', attempts: Array<Record<string, unknown>>) =>
    ({ id: 'r', workflowId: 'w', status, triggerKind: 'manual', startedAt: 1, steps: attempts }) as never;

  it('names the step that failed and why', () => {
    const out = runOutcome(run('failure', [
      { stepId: 'a', status: 'failure', attempt: 1, startedAt: 1, error: 'first' },
      { stepId: 'b', status: 'failure', attempt: 1, startedAt: 2, error: 'exit 1', sessionId: 's' },
    ]), steps);
    expect(out).toEqual({ failed: { stepId: 'b', name: 'Lint', text: 'exit 1', sessionId: 's' } });
  });

  it('gives the last agent answer of a pass, without the outcome token', () => {
    const out = runOutcome(run('success', [
      { stepId: 'c', status: 'success', attempt: 1, startedAt: 1, output: 'Three PRs wait on you. ⟦PASS⟧', sessionId: 's1' },
      { stepId: 'b', status: 'success', attempt: 1, startedAt: 2, output: 'lint ok' },
    ]), steps);
    expect(out.result).toEqual({ stepId: 'c', name: 'Write up', text: 'Three PRs wait on you.', sessionId: 's1' });
    expect(runOutcome(run('cancelled', []), steps)).toEqual({});
  });
});
