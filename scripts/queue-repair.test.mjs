import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BASELINE_WINDOW_MS, CODEX_BUDGET, CODEX_WAIT_MS, RETRY_BUDGET, baselineJobs, codexPrompt, decide, marker, mergeMain, onlyBaseline, readMarkers, ruleFor } from './queue-repair.mjs';

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const pr = (over = {}) => ({ draft: false, crossRepo: false, queued: false, labels: [], mergeable: 'MERGEABLE', head: HEAD, gate: 'SUCCESS', gateAttempt: 0, markers: [], ...over });
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

test('drafts, forks, holds and queued PRs are left alone', () => {
  for (const over of [{ draft: true }, { crossRepo: true }, { labels: ['hold'] }, { queued: true }]) {
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

test('a second ejection at the same head goes to Codex', () => {
  assert.equal(decide(pr({ markers: [mark('sweeper-enqueued')] })).kind, 'queue');
  assert.equal(decide(pr({ markers: [mark('sweeper-enqueued', OLD)] })).action, 'skip');
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

test("a job failing in other PRs' merge groups is main's, not this PR's", () => {
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
  const waiting = decide(pr({ markers: [mark('sweeper-enqueued'), mark('baseline-queue')] }));
  assert.deepEqual(waiting, { action: 'baseline', kind: 'queue', retries: 0 });
  const retried = decide(pr({ markers: [mark('baseline-queue'), ...Array.from({ length: RETRY_BUDGET }, () => mark('retried'))] }));
  assert.equal(retried.retries, RETRY_BUDGET);
  assert.equal(decide(pr({ markers: [mark('baseline-ci', OLD)] })).action, 'skip', 'a marker at an old head does not hold a new push');
  assert.equal(decide(pr({ mergeable: 'CONFLICTING', markers: [mark('baseline-queue')] })).action, 'merge', 'a conflict is still merged');
});

test("the spec index is rebuilt with main's code, never by running the branch's script", () => {
  const src = fs.readFileSync(new URL('./queue-repair.mjs', import.meta.url), 'utf8');
  assert.match(src, /import \{ writeIndex \} from '\.\/spec-index\.mjs'/);
  assert.doesNotMatch(src, /'scripts\/spec-index\.mjs'/, 'no path to the branch copy of the script is executed');
});
