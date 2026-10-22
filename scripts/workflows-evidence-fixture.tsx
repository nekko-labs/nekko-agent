import React from 'react';
import { createRoot } from 'react-dom/client';
import { WorkflowsView } from '../apps/desktop/src/renderer/views/WorkflowsView';
import { useStore } from '../apps/desktop/src/renderer/store';
import '../apps/desktop/src/renderer/styles.css';

// The data set comes from the query string: `empty`, `list`, `paused`, or
// `local` (empty, with a local default model).
const scene = new URLSearchParams(location.search).get('data') || 'list';
const now = Date.now();
const min = 60_000;

const step = (id: string, name: string, kind: string, run: string) => ({ id, name, kind, run });
const workflows = [
  {
    id: 'w1', name: 'Nightly dependency check', category: 'Maintenance', enabled: true, notify: 'always', templateId: 'nightly-dependency-check',
    description: 'Every night the project runs npm outdated and npm audit, and the agent writes up which updates matter and why.',
    steps: [step('a', 'Check for outdated packages', 'shell', 'npm outdated'), step('b', 'Check for known vulnerabilities', 'shell', 'npm audit --omit=dev'), { ...step('c', 'Write it up', 'prompt', 'Summarize:\n{{steps.a.output}}\n{{steps.b.output}}'), tools: 'none' }],
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
  {
    id: 'w4', name: 'Diagnose failed CI', category: 'Code review', enabled: true, notify: 'failure', templateId: 'diagnose-failed-ci',
    localModelOnly: true, toolAccess: 'none', providerId: 'local', modelId: 'qwen3-4b',
    description: 'Watches a GitHub repo for failed Actions runs and keeps one diagnosis comment on the PR.',
    steps: [
      { ...step('logs', 'Read the failed logs', 'action', 'github.runFailureLogs'), params: { repo: '{{trigger.repo}}', run_id: '{{trigger.run_id}}' }, onFailure: { goto: 'fail' } },
      { ...step('diagnose', 'Diagnose', 'prompt', 'A GitHub Actions run failed…\n{{steps.logs.output}}'), tools: 'none' },
      { ...step('comment', 'Comment on the PR', 'action', 'github.upsertPRComment'), params: { repo: '{{trigger.repo}}', number: '{{trigger.number}}', body: '### CI diagnosis for run …\n\n{{steps.diagnose.output}}' }, continueOnError: true },
    ],
    triggers: [{ id: 't4', kind: 'connector', connector: 'github', event: 'workflow_run_failed', repo: 'acme/app', pollIntervalMs: 120_000 }],
    createdAt: now - 86_400_000, updatedAt: now - 86_400_000, lastRunAt: now - 12 * min, lastStatus: 'success', runCount: 3,
  },
  {
    id: 'w5', name: 'Review new PRs with a skill', category: 'Code review', enabled: true, notify: 'failure', templateId: 'review-prs-with-skill',
    localModelOnly: true, toolAccess: 'allowlist', prCheckout: true, providerId: 'local', modelId: 'qwen3-4b',
    description: 'Each new pull request is checked out for the run, reviewed by a skill, and its verdict kept in one comment on the PR.',
    steps: [
      { ...step('review', 'Review', 'skill', 'nyaa:cr'), args: '{{trigger.number}}', with: 'Review the pull request that started this run.' },
      { ...step('comment', 'Comment on the PR', 'action', 'github.upsertPRComment'), params: { repo: '{{trigger.repo}}', number: '{{trigger.number}}', body: '{{steps.review.output}}' } },
    ],
    triggers: [
      { id: 't5', kind: 'connector', connector: 'github', event: 'pr_opened', repo: 'acme/app', pollIntervalMs: 120_000 },
      { id: 't6', kind: 'connector', connector: 'github', event: 'pr_updated', repo: 'acme/app', pollIntervalMs: 120_000, enabled: false },
    ],
    createdAt: now - 86_400_000, updatedAt: now - 86_400_000, lastRunAt: now - 6 * min, lastStatus: 'success', runCount: 2,
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
runs.push(
  {
    id: 'r41', workflowId: 'w4', status: 'success', triggerKind: 'connector', triggerLabel: 'GitHub · CI failed on fix-rounding (run 212)', startedAt: now - 12 * min, endedAt: now - 12 * min + 41_000,
    steps: [
      attempt('logs', 'success', now - 12 * min, { output: '### test / Run unit tests\nFAIL src/math.test.js\n  ● add › adds two numbers\n    Expected: 4\n    Received: 5' }),
      attempt('diagnose', 'success', now - 12 * min + 3_000, { sessionId: 's41', output: '**Failing:** job `test`, step *Run unit tests*.\n\n**Likely cause:** `add(2, 2)` returns 5, so `src/math.js` adds an extra 1 (`Expected: 4, Received: 5` at src/math.test.js:4).\n\n**Suggested fix:** return `a + b` in `add` and re-run the tests.' }),
      attempt('comment', 'success', now - 12 * min + 38_000, { output: 'Updated the comment on acme/app#57 https://github.com/acme/app/pull/57#issuecomment-1' }),
    ],
  },
  {
    id: 'r42', workflowId: 'w4', status: 'success', triggerKind: 'connector', triggerLabel: 'GitHub · CI failed on main (run 209)', startedAt: now - 3 * 60 * min, endedAt: now - 3 * 60 * min + 36_000,
    steps: [
      attempt('logs', 'success', now - 3 * 60 * min, { output: '### build / Compile' }),
      attempt('diagnose', 'success', now - 3 * 60 * min + 3_000, { sessionId: 's42', output: 'The log does not show enough to tell.' }),
      attempt('comment', 'success', now - 3 * 60 * min + 35_000, { output: 'No PR, skipped.' }),
    ],
  },
);
runs.push(
  {
    id: 'r51', workflowId: 'w5', status: 'success', triggerKind: 'connector', triggerLabel: 'GitHub · acme/app · pr_opened · PR #61 opened: Add average()', startedAt: now - 6 * min, endedAt: now - 6 * min + 95_000,
    steps: [
      attempt('review', 'success', now - 6 * min, { sessionId: 's51', output: '## nyaa council: PR #61\n\n**Mochi (correctness):** `average()` reads one past the end: the loop runs to `i <= values.length`, so `values[values.length]` is `undefined` and the total becomes `NaN` (src/average.js:4). Use `i < values.length`.\n\n**Tora (dependencies):** `pnpm audit --prod`: no known vulnerabilities.\n\n**Shiro (lint):** `npm run lint` exit 0.\n\n**Verdict:** request changes (1 blocking).' }),
      attempt('comment', 'success', now - 6 * min + 90_000, { output: 'Posted a comment on acme/app#61 https://github.com/acme/app/pull/61#issuecomment-2' }),
    ],
  },
  {
    id: 'r52', workflowId: 'w5', status: 'success', triggerKind: 'connector', triggerLabel: 'GitHub · acme/app · pr_opened · PR #60 opened: Fix typo (from a fork)', startedAt: now - 50 * min, endedAt: now - 50 * min + 70_000,
    steps: [
      attempt('review', 'success', now - 50 * min, { sessionId: 's52', output: '## nyaa council: PR #60\n\nlint/audit skipped: untrusted PR.\n\n**Mochi:** the typo fix in README.md is correct.\n\n**Verdict:** approve.' }),
      attempt('comment', 'success', now - 50 * min + 65_000, { output: 'Posted a comment on acme/app#60 https://github.com/acme/app/pull/60#issuecomment-3' }),
    ],
  },
);
const skillDefs = [
  ...['research', 'plan', 'review', 'security-review', 'simplify', 'test'].map((n) => ({ id: n, name: n, description: `Built-in ${n}`, template: '', category: 'Code quality', workflow: { nodes: [], edges: [] }, source: 'builtin' })),
  { id: 'external:claude:user:triage', name: 'triage', description: 'Sort new issues by area and urgency', template: '', category: 'Imported', workflow: { nodes: [], edges: [] }, source: 'external', origin: { tool: 'claude', scope: 'user', dir: '/Users/me/.claude/skills/triage' } },
  {
    id: 'nyaa:cr', name: 'nyaa:cr', description: 'nyaa: summon the council of reviewer cats over a PR or the working diff', template: '', category: 'Imported', workflow: { nodes: [], edges: [] },
    source: 'plugin', pluginRoot: '/Users/me/.claude/plugins/cache/nekko-dojo-skills/nyaa/1.0.0', argumentHint: '[PR number | empty for current branch / working diff]',
    allowedTools: ['Bash(gh:*)', 'Bash(git:*)', 'Bash(pnpm:*)', 'Bash(npm:*)', 'Read', 'Grep', 'Glob'],
    origin: { tool: 'claude-plugin', scope: 'user', dir: '/Users/me/.claude/plugins/cache/nekko-dojo-skills/nyaa/1.0.0', plugin: 'nyaa', marketplace: 'nekko-dojo-skills', version: '1.0.0', kind: 'command' },
  },
  {
    id: 'nyaa:nyaa', name: 'nyaa:nyaa', description: 'The nyaa review council', template: '', category: 'Imported', workflow: { nodes: [], edges: [] },
    source: 'plugin', pluginRoot: '/Users/me/.claude/plugins/cache/nekko-dojo-skills/nyaa/1.0.0', allowedTools: [],
    origin: { tool: 'claude-plugin', scope: 'user', dir: '/Users/me/.claude/plugins/cache/nekko-dojo-skills/nyaa/1.0.0/skills/nyaa', plugin: 'nyaa', marketplace: 'nekko-dojo-skills', version: '1.0.0', kind: 'skill' },
  },
];
const snapshot = scene === 'empty' || scene === 'local' ? { workflows: [], runs: [] } : { workflows, runs };

// The view reads the store and this bridge; every other call answers nothing.
const w = window as unknown as { nekko: unknown };
w.nekko = new Proxy({}, {
  get: (_, k: string) =>
    k === 'listWorkflows' ? () => Promise.resolve(snapshot)
      : k === 'listWorkflowSkillDefs' ? () => Promise.resolve(skillDefs)
      : k === 'listModels' ? (id: string) => Promise.resolve(id === 'local' ? [{ id: 'qwen3-4b', providerId: 'local', name: 'Qwen3 4B' }] : [])
      : k.startsWith('on') ? () => () => {}
      : () => Promise.resolve(null),
});

useStore.setState({
  installedSkillDefs: [],
  settings: {
    automationsPaused: scene === 'paused',
    connectors: [{ kind: 'github', connected: true }],
    workspaces: [{ id: 'ws1', path: '/Users/me/code/app', name: 'app' }],
    providers: [
      { id: 'anthropic', kind: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com', enabled: true },
      { id: 'local', kind: 'llamacpp', label: 'Nekko engine', baseUrl: 'http://127.0.0.1:11500/v1', enabled: true },
    ],
    defaultProviderId: scene === 'local' ? 'local' : 'anthropic',
    defaultModelId: scene === 'local' ? 'qwen3-4b' : 'claude-sonnet-5-5',
  } as never,
});
createRoot(document.getElementById('root')!).render(
  <main className="bg-paper text-ink" style={{ width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column' }}>
    <WorkflowsView />
  </main>,
);
