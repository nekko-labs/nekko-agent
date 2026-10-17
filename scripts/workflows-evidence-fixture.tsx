import React from 'react';
import { createRoot } from 'react-dom/client';
import { WorkflowsView } from '../apps/desktop/src/renderer/views/WorkflowsView';
import { useStore } from '../apps/desktop/src/renderer/store';
import '../apps/desktop/src/renderer/styles.css';

// The data set comes from the query string: `empty`, `list` or `paused`.
const scene = new URLSearchParams(location.search).get('data') || 'list';
const now = Date.now();
const min = 60_000;

const step = (id: string, name: string, kind: string, run: string) => ({ id, name, kind, run });
const workflows = [
  {
    id: 'w1', name: 'Nightly dependency check', category: 'Maintenance', enabled: true, notify: 'always', templateId: 'nightly-dependency-check',
    description: 'Every night the project runs npm outdated and npm audit, and the agent writes up which updates matter and why.',
    steps: [step('a', 'Check for outdated packages', 'shell', 'npm outdated'), step('b', 'Check for known vulnerabilities', 'shell', 'npm audit --omit=dev'), step('c', 'Write it up', 'prompt', 'Summarize')],
    triggers: [{ id: 't1', kind: 'schedule', cron: '0 3 * * *' }],
    createdAt: now - 3 * 86_400_000, updatedAt: now - 3 * 86_400_000, lastRunAt: now - 7 * 60 * min, lastStatus: 'success', runCount: 3, nextRunAt: now + 17 * 60 * min,
  },
  {
    id: 'w2', name: 'Review every PR I open', category: 'Code review', enabled: true, templateId: 'review-my-prs',
    description: 'Watches a GitHub repo for pull requests you open and reviews each diff.',
    steps: [step('r', 'Review the diff', 'prompt', 'Review the pull request that triggered this run.')],
    triggers: [{ id: 't2', kind: 'connector', connector: 'github', event: 'PullRequestEvent', repo: 'acme/app', action: 'opened', actor: 'octocat', pollIntervalMs: 120_000 }],
    createdAt: now - 2 * 86_400_000, updatedAt: now - 2 * 86_400_000, lastRunAt: now - 25 * min, lastStatus: 'failure', runCount: 2,
  },
  {
    id: 'w3', name: 'Build, then verify (loops back)', category: 'Build & test', enabled: false,
    steps: [step('b1', 'Build', 'prompt', 'Implement'), step('v1', 'Verify', 'shell', 'npm test')],
    triggers: [{ id: 't3', kind: 'manual' }],
    createdAt: now - 86_400_000, updatedAt: now - 86_400_000, runCount: 0,
  },
];
const attempt = (stepId: string, status: string, at: number, extra: object = {}) => ({ stepId, status, attempt: 1, startedAt: at, endedAt: at + 20_000, ...extra });
const runs = [
  {
    id: 'r21', workflowId: 'w2', status: 'failure', triggerKind: 'connector', triggerLabel: 'GitHub · PullRequestEvent #482 opened', startedAt: now - 25 * min, endedAt: now - 24 * min,
    steps: [attempt('r', 'failure', now - 25 * min, { sessionId: 's21', error: 'gh: Could not resolve to a PullRequest with the number of 482. (HTTP 404)' })],
    message: '"Review the diff" failed.',
  },
  {
    id: 'r22', workflowId: 'w2', status: 'success', triggerKind: 'connector', triggerLabel: 'GitHub · PullRequestEvent #479 opened', startedAt: now - 26 * 60 * min, endedAt: now - 26 * 60 * min + 3 * min,
    steps: [attempt('r', 'success', now - 26 * 60 * min, { sessionId: 's22', output: 'No correctness bugs. One simplification in src/parse.ts:41. ⟦PASS⟧' })],
  },
  {
    id: 'r11', workflowId: 'w1', status: 'success', triggerKind: 'schedule', triggerLabel: 'Schedule', startedAt: now - 7 * 60 * min, endedAt: now - 7 * 60 * min + 94_000,
    steps: [
      attempt('a', 'success', now - 7 * 60 * min, { output: 'react 18.3.1 → 19.1.0\nvite 5.4.0 → 6.2.1' }),
      attempt('b', 'success', now - 7 * 60 * min + 20_000, { output: 'found 1 moderate severity vulnerability' }),
      attempt('c', 'success', now - 7 * 60 * min + 40_000, {
        sessionId: 's11',
        output: 'Worth doing now: the moderate advisory in vite 5.4.0 (dev server path traversal); 6.2.1 fixes it.\nCan wait: React 19 is a major upgrade; plan it with the router change.\nNothing else is outdated. ⟦PASS⟧',
      }),
    ],
  },
  {
    id: 'r12', workflowId: 'w1', status: 'failure', triggerKind: 'schedule', triggerLabel: 'Schedule', startedAt: now - 31 * 60 * min, endedAt: now - 31 * 60 * min + 5_000,
    steps: [attempt('a', 'failure', now - 31 * 60 * min, { error: 'Command failed: npm outdated\nnpm ERR! enoent Could not read package.json' })],
  },
];
const snapshot = scene === 'empty' ? { workflows: [], runs: [] } : { workflows, runs };

// The view reads the store and this bridge; every other call answers nothing.
const w = window as unknown as { nekko: unknown };
w.nekko = new Proxy({}, {
  get: (_, k: string) =>
    k === 'listWorkflows' ? () => Promise.resolve(snapshot)
      : k.startsWith('on') ? () => () => {}
      : () => Promise.resolve(null),
});

useStore.setState({
  installedSkillDefs: [],
  settings: {
    automationsPaused: scene === 'paused',
    connectors: [{ kind: 'github', connected: true }],
    workspaces: [{ id: 'ws1', path: '/Users/me/code/app', name: 'app' }],
    defaultProviderId: 'anthropic',
    defaultModelId: 'claude-sonnet-5-5',
  } as never,
});
createRoot(document.getElementById('root')!).render(
  <main className="bg-paper text-ink" style={{ width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column' }}>
    <WorkflowsView />
  </main>,
);
