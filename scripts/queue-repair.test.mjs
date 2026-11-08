import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BASELINE_WINDOW_MS, CODEX_BUDGET, CODEX_WAIT_MS, RETRY_BUDGET, baselineJobs, codexPrompt, decide, latestCiRuns, marker, mergeMain, onlyBaseline, readMarkers, retryBaseline, ruleFor } from './queue-repair.mjs';

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const pr = (over = {}) => ({ draft: false, crossRepo: false, labels: [], mergeable: 'MERGEABLE', head: HEAD, gate: 'SUCCESS', gateAttempt: 0, markers: [], ...over });
const mark = (kind, sha = HEAD, at = 0) => ({ kind, sha, at });

test('rules cover only files that need no judgment', () => {
  assert.equal(ruleFor('spec/README.md'), 'take-main-and-reindex');
  assert.equal(ruleFor('apps/website/llms.txt'), 'take-main');
  assert.equal(ruleFor('docs/perf-history.md'), 'union');
  assert.equal(ruleFor('TASKS.md', { mainHasTaskLog: true }), 'union');
  assert.equal(ruleFor('TASKS.md', { mainHasTaskLog: false }), 'take-main-keep-additions');
  assert.equal(ruleFor('apps/desktop/src/App.tsx'), null);
  assert.equal(ruleFor('docs/hub/nav.json'), null);
});

test('markers are read from both the repair and the sweeper comments', () => {
  const comments = [
    { body: `Queue sweeper: re-queued. <!-- queue-sweeper:enqueued:${HEAD} -->`, createdAt: '2026-11-04T00:00:00Z' },
    { body: `@codex fix it\n\n${marker('codex-ci', OLD)}`, createdAt: '2026-11-04T01:00:00Z' },
    { body: 'no marker here', createdAt: '2026-11-04T02:00:00Z' },
  ];
  assert.deepEqual(readMarkers(comments), [
    { kind: 'sweeper-enqueued', sha: HEAD, at: Date.parse('2026-11-04T00:00:00Z') },
    { kind: 'codex-ci', sha: OLD, at: Date.parse('2026-11-04T01:00:00Z') },
  ]);
});

test('drafts, forks and holds are left alone', () => {
  for (const over of [{ draft: true }, { crossRepo: true }, { labels: ['hold'] }]) {
    assert.equal(decide(pr({ ...over, mergeable: 'CONFLICTING' })).action, 'skip', JSON.stringify(over));
  }
});

test('a conflicting or not-yet-computed PR is merged locally', () => {
  assert.equal(decide(pr({ mergeable: 'CONFLICTING' })).action, 'merge');
  assert.equal(decide(pr({ mergeable: 'UNKNOWN' })).action, 'merge');
});

test('a red gate goes to Codex only after the sweeper re-ran it', () => {
  assert.equal(decide(pr({ gate: 'FAILURE', gateAttempt: 1 })).action, 'skip');
  assert.deepEqual(decide(pr({ gate: 'FAILURE', gateAttempt: 2 })), { action: 'codex', kind: 'ci', why: "gate is FAILURE after the sweeper's re-run" });
});

test('old merge-queue markers no longer hand a green PR to Codex', () => {
  for (const markers of [[mark('sweeper-enqueued')], [mark('baseline-queue')]]) assert.equal(decide(pr({ markers })).action, 'skip', JSON.stringify(markers));
});

test('Codex gets an hour per request, then a person is asked', () => {
  const now = 10 * CODEX_WAIT_MS;
  const waiting = pr({ mergeable: 'CONFLICTING', markers: [mark('codex-conflict', HEAD, now - 1000)] });
  assert.equal(decide(waiting, now).why, 'waiting for Codex');
  const stale = pr({ markers: [mark('codex-conflict', HEAD, now - CODEX_WAIT_MS - 1)] });
  assert.equal(decide(stale, now).action, 'needs-human');
});

test('a PR given to a person stays with them until a new push', () => {
  assert.equal(decide(pr({ mergeable: 'CONFLICTING', markers: [mark('needs-human')] })).action, 'skip');
  assert.equal(decide(pr({ mergeable: 'CONFLICTING', markers: [mark('needs-human', OLD)] })).action, 'merge');
});

test('Codex is asked at most CODEX_BUDGET times per PR', () => {
  const spent = Array.from({ length: CODEX_BUDGET }, (_, i) => mark('codex-ci', String(i).repeat(40)));
  assert.equal(decide(pr({ gate: 'FAILURE', gateAttempt: 2, markers: spent })).action, 'needs-human');
});

test('the Codex request names the work and the house rules', () => {
  const conflict = codexPrompt('conflict', { branch: 'feat/x', head: HEAD, files: ['apps/a.ts'] });
  assert.match(conflict, /^@codex Merge `main`/);
  assert.match(conflict, /- `apps\/a\.ts`/);
  assert.match(conflict, /no AI attribution/);
  assert.match(conflict, /`feat\/x`/);
  const ci = codexPrompt('ci', { branch: 'feat/x', head: HEAD, jobs: [{ name: 'daemon (windows)', url: 'https://x/1' }] });
  assert.match(ci, /\[daemon \(windows\)\]\(https:\/\/x\/1\)/);
  assert.match(ci, /Never weaken a test/);
});

/* A real repository: main and a PR branch that both touched the hot files. */

function repoWith(setup) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-repair-test-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'test');
  git('config', 'user.email', 'test@example.com');
  const commit = (msg) => {
    git('add', '-A');
    git('commit', '-q', '-m', msg);
    return git('rev-parse', 'HEAD');
  };
  setup({ git, write, commit });
  return { dir, git, read: (f) => fs.readFileSync(path.join(dir, f), 'utf8') };
}

// Laid out like the real TASKS.md: task groups on top, then Part 1, then Part 2.
const PLAN = '## Part 1, Plan\n\nstack\n\n- one\n- two\n- three\n- four\n';
const TASKS_WITH_LOG = `# Plan\n\n## Old work (#1)\n\n- [x] old\n\n${PLAN}\n## Part 2, Tasks\n\n- old task\n`;
const TASKS_PLAN_ONLY = `# Plan\n\n> Tasks live in GitHub issues.\n\n${PLAN}`;
const PERF = '# Performance history\n\n## 2026-11\n\n### #1 first\n';

function hotFileRepo({ mainDropsTaskLog, codeConflict }) {
  let head;
  const r = repoWith(({ git, write, commit }) => {
    write('spec/README.md', '# Spec\n\n- a (1 KB)\n');
    write('TASKS.md', TASKS_WITH_LOG);
    write('docs/perf-history.md', PERF);
    write('src/app.js', 'export const x = 1;\n');
    commit('base');
    git('checkout', '-q', '-b', 'feature');
    write('spec/README.md', '# Spec\n\n- a (2 KB)\n');
    // A new task group on top, as every PR did, and a real plan edit in Part 1.
    write('TASKS.md', TASKS_WITH_LOG.replace('## Old work', '## Feature work (#9)\n\n- [ ] do the feature\n\n## Old work').replace('stack', 'stack and a queue'));
    write('docs/perf-history.md', `${PERF}\n### #9 feature speedup\n`);
    if (codeConflict) write('src/app.js', 'export const x = 2;\n');
    head = commit('feature');
    git('checkout', '-q', 'main');
    write('spec/README.md', '# Spec\n\n- a (3 KB)\n');
    write('TASKS.md', mainDropsTaskLog ? TASKS_PLAN_ONLY : TASKS_WITH_LOG.replace('## Old work', '## Main work (#8)\n\n- [x] done\n\n## Old work'));
    write('docs/perf-history.md', `${PERF}\n### #8 main speedup\n`);
    if (codeConflict) write('src/app.js', 'export const x = 3;\n');
    commit('main');
  });
  return { ...r, head };
}

test('hot-file conflicts are resolved and committed as a merge', () => {
  const { dir, git, head } = hotFileRepo({ mainDropsTaskLog: true });
  const workdir = path.join(os.tmpdir(), `queue-repair-wt-${process.pid}-1`);
  try {
    const r = mergeMain({ repo: dir, head, mainRef: 'main', workdir, branch: 'feature', author: { name: 'repair-bot', email: 'bot@example.com' } });
    assert.equal(r.status, 'resolved');
    assert.equal(git('log', '-1', '--format=%an <%ae>', r.sha), 'repair-bot <bot@example.com>');
    assert.equal(git('config', '--local', 'user.name'), 'test', "the repository's own identity is untouched");
    assert.deepEqual(r.resolved.map((x) => `${x.file}:${x.rule}`).sort(), ['TASKS.md:take-main-keep-additions', 'spec/README.md:take-main-and-reindex']);
    const at = (f) => execFileSync('git', ['show', `${r.sha}:${f}`], { cwd: dir, encoding: 'utf8' });
    assert.equal(at('spec/README.md'), '# Spec\n\n- a (3 KB)\n');
    // Main's plan-only layout wins the clash; the PR's Part 1 edit still lands.
    assert.equal(at('TASKS.md'), TASKS_PLAN_ONLY.replace('stack', 'stack and a queue'));
    assert.ok(r.additions['TASKS.md'].includes('- [ ] do the feature'));
    assert.ok(!r.additions['TASKS.md'].some((l) => l.includes('a queue')), 'only the clashing lines are reported');
    // perf-history merged with the union attribute: no conflict, both entries kept.
    assert.match(at('docs/perf-history.md'), /#9 feature speedup[\s\S]*#8 main speedup|#8 main speedup[\s\S]*#9 feature speedup/);
    assert.equal(git('rev-list', '--parents', '-n', '1', r.sha).split(' ').length, 3, 'a merge commit');
  } finally {
    git('worktree', 'remove', '--force', workdir);
  }
});

test('before the task log moved, both sides keep their TASKS.md entries', () => {
  const { dir, git, head } = hotFileRepo({ mainDropsTaskLog: false });
  const workdir = path.join(os.tmpdir(), `queue-repair-wt-${process.pid}-2`);
  try {
    const r = mergeMain({ repo: dir, head, mainRef: 'main', workdir, branch: 'feature' });
    assert.equal(r.status, 'resolved');
    const tasks = execFileSync('git', ['show', `${r.sha}:TASKS.md`], { cwd: dir, encoding: 'utf8' });
    assert.match(tasks, /Feature work \(#9\)/);
    assert.match(tasks, /Main work \(#8\)/);
    assert.doesNotMatch(tasks, /<<<<<<<|>>>>>>>/);
  } finally {
    git('worktree', 'remove', '--force', workdir);
  }
});

test('a conflict in code is left for Codex, and the merge is aborted', () => {
  const { dir, git, head } = hotFileRepo({ mainDropsTaskLog: true, codeConflict: true });
  const workdir = path.join(os.tmpdir(), `queue-repair-wt-${process.pid}-3`);
  try {
    const r = mergeMain({ repo: dir, head, mainRef: 'main', workdir, branch: 'feature' });
    assert.equal(r.status, 'unresolved');
    assert.deepEqual(r.unresolved, ['src/app.js']);
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: workdir, encoding: 'utf8' }), '');
  } finally {
    git('worktree', 'remove', '--force', workdir);
  }
});

test('a branch that already contains main needs nothing', () => {
  const { dir, git } = hotFileRepo({ mainDropsTaskLog: true });
  const r = mergeMain({ repo: dir, head: git('rev-parse', 'main'), mainRef: 'main', workdir: path.join(os.tmpdir(), 'unused'), branch: 'main' });
  assert.equal(r.status, 'up-to-date');
});

test("a job failing in other PRs' CI runs is main's, not this PR's", () => {
  const now = Date.parse('2026-11-04T16:00:00Z');
  const runs = [
    { pr: 1716, at: now - 1000, failed: ['perf', 'gate'] },
    { pr: 1654, at: now - 2000, failed: ['perf', 'gate'] },
    { pr: 1652, at: now - 3000, failed: ['perf', 'gate'] },
    { pr: 1650, at: now - 4000, failed: ['build', 'gate'] },
    { pr: 1601, at: now - BASELINE_WINDOW_MS - 1, failed: ['build'] },
  ];
  const base = baselineJobs(runs, 1716, now);
  assert.deepEqual([...base], ['perf'], 'perf failed for two other PRs; build for one in the window; gate never counts; own runs never count');
  assert.equal(onlyBaseline([{ name: 'perf' }], base), true);
  assert.equal(onlyBaseline([{ name: 'perf' }, { name: 'build' }], base), false, 'one job of its own makes it the PR\'s');
  assert.equal(onlyBaseline([], base), false, 'no failed job found is not a baseline failure');
});

test('a PR waiting on main is not handed to Codex, and is retried a bounded number of times', () => {
  const waiting = decide(pr({ gate: 'FAILURE', gateAttempt: 2, markers: [mark('baseline-ci')] }));
  assert.deepEqual(waiting, { action: 'baseline', kind: 'ci', retries: 0 });
  const retried = decide(pr({ gate: 'FAILURE', gateAttempt: 2, markers: [mark('baseline-ci'), ...Array.from({ length: RETRY_BUDGET }, () => mark('retried'))] }));
  assert.equal(retried.retries, RETRY_BUDGET);
  assert.equal(decide(pr({ markers: [mark('baseline-ci', OLD)] })).action, 'skip', 'a marker at an old head does not hold a new push');
  assert.equal(decide(pr({ mergeable: 'CONFLICTING', markers: [mark('baseline-ci')] })).action, 'merge', 'a conflict is still merged');
});

test("the spec index is rebuilt with main's code, never by running the branch's script", () => {
  const src = fs.readFileSync(new URL('./queue-repair.mjs', import.meta.url), 'utf8');
  assert.match(src, /import \{ writeIndex \} from '\.\/spec-index\.mjs'/);
  assert.doesNotMatch(src, /'scripts\/spec-index\.mjs'/, 'no path to the branch copy of the script is executed');
});

test('a baseline marker never retries a green, pending or stale-head gate', () => {
  for (const over of [{ gate: 'SUCCESS', gateAttempt: 2 }, { gate: '', gateAttempt: 0 }, { gate: 'FAILURE', gateAttempt: 0 }]) {
    assert.equal(decide(pr({ ...over, markers: [mark('baseline-ci')] })).action, 'skip', JSON.stringify(over));
  }
});

test('newer successful runs clear old same-PR failures regardless of API ordering', () => {
  const now = Date.now();
  const runs = [
    { pr: 1, at: now - 3000, failed: ['build'] },
    { pr: 2, at: now - 2000, failed: ['build'] },
    { pr: 1, at: now - 1000, failed: [] },
  ];
  for (const list of [runs, runs.toReversed()]) assert.deepEqual([...baselineJobs(list, 9, now)], []);
  assert.deepEqual([...baselineJobs([...runs, { pr: 1, at: now, failed: ['build'] }], 9, now)], ['build']);
});

test('latest CI evidence includes success but ignores pending, cancellation and other workflows', () => {
  const now = Date.now();
  const run = (id, pr, ago, over = {}) => ({ id, name: 'CI', status: 'completed', conclusion: 'failure', created_at: new Date(now - ago).toISOString(), pull_requests: [{ number: pr }], ...over });
  const runs = [
    run(1, 1, 9000), run(2, 1, 8000, { conclusion: 'success' }),
    run(3, 1, 7000, { status: 'in_progress', conclusion: null }),
    run(4, 2, 6000), run(5, 2, 5000, { conclusion: 'cancelled' }),
    run(6, 2, 4000, { name: 'Native iOS', conclusion: 'success' }),
    run(7, 3, BASELINE_WINDOW_MS + 1), run(8, 4, 1000, { pull_requests: [] }),
  ];
  for (const list of [runs, runs.toReversed()]) assert.deepEqual(latestCiRuns(list, now).map(r => r.id).sort(), [2, 4]);
});

function retryFixture(status, over = {}) {
  const calls = [];
  const request = (args, options) => {
    calls.push({ args, options });
    if (args.includes('PUT') && over.error) throw new Error(over.error);
    return calls.length === 1 ? status : '{}';
  };
  const result = () => retryBaseline({ number: 2224, head: HEAD, gateRun: 123, retries: 0, ...over.pr }, {
    stillFailing: false, dryRun: false, pushToken: 'synthetic-app-token', request, ...over.options,
  });
  return { calls, result };
}

test('newer main is merged with the exact expected head and App token, never a stale rerun', () => {
  for (const status of ['ahead', 'diverged']) {
    // Refresh even before other PRs recover: their historical failures do not
    // prove a new main fix is absent. The new snapshot must pass CI normally.
    const { calls, result } = retryFixture(status, { options: { stillFailing: true } });
    assert.equal(result(), 'refresh');
    assert.match(calls[0].args[1], new RegExp(`/compare/${HEAD}\\.\\.\\.main$`));
    assert.deepEqual(calls[1], {
      args: ['api', '--method', 'PUT', 'repos/nekko-labs/nekko-agent/pulls/2224/update-branch', '-f', `expected_head_sha=${HEAD}`],
      options: { token: 'synthetic-app-token' },
    });
    assert.equal(calls.length, 2);
    assert.ok(!calls.some(c => c.args.includes('rerun')));
  }
});

test('dry run compares ancestry but never updates a branch or reruns CI', () => {
  for (const status of ['ahead', 'diverged', 'behind', 'identical']) {
    const { calls, result } = retryFixture(status, { options: { dryRun: true } });
    assert.equal(result(), ['ahead', 'diverged'].includes(status) ? 'refresh' : 'rerun');
    assert.equal(calls.length, 1);
  }
});

test('an up-to-date branch waits while the shared failure signal persists', () => {
  for (const status of ['behind', 'identical']) {
    const { calls, result } = retryFixture(status, { options: { stillFailing: true } });
    assert.equal(result(), 'wait');
    assert.equal(calls.length, 1);
  }
});

test('a cleared signal retries only an up-to-date branch, within the budget', () => {
  for (const status of ['behind', 'identical']) {
    const { calls, result } = retryFixture(status);
    assert.equal(result(), 'rerun');
    assert.deepEqual(calls[1].args, ['run', 'rerun', '123', '--failed']);
    const exhausted = retryFixture(status, { pr: { retries: RETRY_BUDGET } });
    assert.equal(exhausted.result(), 'exhausted');
    assert.equal(exhausted.calls.length, 1);
  }
});

test('conflicts, racing heads and denied updates never fall back to the stale run', () => {
  for (const error of ['merge conflict (422)', 'expected head changed (422)', 'workflow permission denied (403)']) {
    const { calls, result } = retryFixture('diverged', { error });
    assert.throws(result, { message: error });
    assert.equal(calls.length, 2);
    assert.ok(!calls.some(c => c.args.includes('rerun')));
  }
});

test('missing App credentials and unknown ancestry fail closed', () => {
  const missing = retryFixture('ahead', { options: { pushToken: '' } });
  assert.throws(missing.result, /PUSH_TOKEN is required/);
  assert.equal(missing.calls.length, 1);
  const unknown = retryFixture('unexpected');
  assert.throws(unknown.result, /Unexpected main comparison/);
  assert.equal(unknown.calls.length, 1);
});

test('recovery incorporates a real main fix without losing the feature commit', () => {
  let head;
  const { dir, git } = repoWith(({ git, write, commit }) => {
    write('app.js', 'broken baseline\n'); commit('base');
    git('checkout', '-q', '-b', 'feature');
    write('feature.js', 'keep approval fix\n'); head = commit('feature');
    git('checkout', '-q', 'main'); write('app.js', 'fixed baseline\n'); commit('fix main');
    git('checkout', '-q', 'feature');
  });
  const request = args => {
    if (args.includes('--jq')) {
      const base = git('merge-base', head, 'main');
      return base === git('rev-parse', 'main') ? 'behind' : base === head ? 'ahead' : 'diverged';
    }
    assert.ok(args.includes(`expected_head_sha=${git('rev-parse', 'HEAD')}`));
    assert.ok(args.includes('PUT'));
    git('merge', '--no-ff', '--no-edit', 'main');
    return '{}';
  };
  try {
    assert.equal(retryBaseline({ number: 2224, head }, { stillFailing: true, request, pushToken: 'synthetic' }), 'refresh');
    assert.equal(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), 'fixed baseline\n');
    assert.equal(fs.readFileSync(path.join(dir, 'feature.js'), 'utf8'), 'keep approval fix\n');
    assert.equal(git('merge-base', head, 'HEAD'), head, 'history is not rewritten');
    assert.equal(git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('merged PRs with empty PR metadata retain newer green evidence under branch identity', () => {
  const now = Date.now();
  const old = { id: 1, name: 'CI', head_branch: 'feature', head_repository: { full_name: 'nekko-labs/nekko-agent' }, status: 'completed', conclusion: 'failure', created_at: new Date(now - 2000).toISOString(), pull_requests: [{ number: 1 }] };
  const green = { ...old, id: 2, conclusion: 'success', created_at: new Date(now - 1000).toISOString(), pull_requests: [] };
  const fork = { ...old, id: 3, head_repository: { full_name: 'someone/fork' } };
  for (const list of [[old, green, fork], [fork, green, old]]) {
    assert.deepEqual(latestCiRuns(list, now).map(r => r.id).sort(), [2, 3]);
  }
  const failures = [{ pr: 'repo:feature', branch: 'feature', at: now, failed: ['build'] }, { pr: 2, branch: 'other', at: now, failed: ['build'] }];
  assert.deepEqual([...baselineJobs(failures, 1, now, 'feature')], [], 'own branch never supplies independent baseline evidence');
});
