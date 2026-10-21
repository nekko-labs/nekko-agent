import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { expect, it } from 'vitest';
import { PhoneAccessError, redactPhoneResult, screenPhoneCall } from './phone-access.js';

/**
 * Shared cases for git from a phone (phone-git.ts): how the computer screens
 * a phone's git call and what the phone receives back. The daemon's copy
 * (crates/nekko-remote/src/phone_git.rs) is checked against the same file by
 * crates/nekko-remote/tests/golden.rs. UPDATE_GOLDEN=1 rewrites it from this
 * TS; without it, this fails when the file is stale.
 */
const path = join(__dirname, '..', '..', '..', 'crates', 'nekko-remote', 'tests', 'golden', 'phone-git.json');

const URL = 'https://github.com/o/r/pull/7';
const WS = 'session:s1';

const screens: Array<[string, unknown[]]> = [
  ['workspace:gitStatus', [WS]],
  ['workspace:gitStatus', [WS, true]],
  ['workspace:gitStatus', ['w1']],
  ['workspace:gitStatus', ['session:']],
  ['workspace:gitStatus', [WS, 'yes']],
  ['git:diff', [WS]],
  ['git:diff', [WS, { staged: true, path: 'src', base: 'main' }]],
  ['git:diff', [WS, { staged: 'yes' }]],
  ['git:diff', [WS, { cwd: '/' }]],
  ['git:diff', [WS, 'staged']],
  ['git:diff', [{ id: 'w1' }]],
  ['git:log', [WS, { limit: 20, skip: 40, ref: 'main', path: 'README.md' }]],
  ['git:log', [WS, { limit: -1 }]],
  ['git:log', [WS, { limit: 2.5 }]],
  ['git:show', [WS, 'abc1234']],
  ['git:show', [WS, '']],
  ['git:show', [WS]],
  ['git:branches', [WS, 'extra']],
  ['git:compare', [WS, 'main', 'feat']],
  ['git:compare', [WS, 'main']],
  ['git:stage', [WS, ['a.txt', 'src/b.ts']]],
  ['git:stage', [WS, []]],
  ['git:stage', [WS, ['a.txt', 3]]],
  ['git:stage', ['w1', ['a.txt']]],
  ['git:unstage', [WS, ['a.txt']]],
  ['git:commit', [WS, { message: 'Fix the thing' }]],
  ['git:commit', [WS, { message: '   ' }]],
  ['git:commit', [WS, { message: 'x', amend: true }]],
  ['git:commit', [WS]],
  ['git:commitMessage', [WS]],
  ['git:push', [WS]],
  ['git:push', [WS, { setUpstream: true }]],
  ['git:push', [WS, { force: true }]],
  ['git:switch', [WS, 'feat']],
  ['git:switch', [WS, 'feat', { create: true }]],
  ['git:switch', [WS, 'feat', { create: 'yes' }]],
  ['git:switch', [WS, '']],
  ['git:mergeAbort', [WS]],
  ['pr:create', [WS, { title: 'Add it', body: 'Why', base: 'main', draft: true }]],
  ['pr:create', [WS, { title: '' }]],
  ['pr:create', [WS, { title: 'x', reviewers: ['a'] }]],
  ['pr:checks', [URL]],
  ['pr:checks', ['https://example.com/o/r/pull/7']],
  ['pr:checks', [`${URL}/files`]],
  ['pr:diff', [URL]],
  ['pr:action', [URL, 'merge']],
  ['pr:action', [URL, 'delete']],
  ['pr:action', ['https://github.com/o/r/issues/7', 'close']],
  ['pr:continueStack', [URL]],
  ['pr:linkStack', [URL]],
];

const commit = (sha: string, subject: string) => ({
  sha: sha.repeat(40).slice(0, 40),
  short: sha.repeat(7).slice(0, 7),
  parents: ['p'.repeat(40)],
  author: 'Ada Lovelace',
  email: 'ada@example.com',
  date: '2026-10-20T10:00:00+00:00',
  subject,
});

const patchOf = (n: number) => ['@@ -1,0 +1,' + n + ' @@', ...Array.from({ length: n }, (_, i) => `+line ${i}`)].join('\n');

const files = [
  { path: 'src/app.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1,2 +1,2 @@\n-a\n+b\n c' },
  { path: '.env', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-KEY=1\n+KEY=2' },
  { path: 'keys/server.pem', oldPath: 'server.pem', status: 'renamed', additions: 0, deletions: 0, patch: '' },
  { path: 'img.png', status: 'added', additions: 0, deletions: 0, binary: true, patch: '' },
  { path: 'new.txt', status: 'added', additions: 2, deletions: 0, untracked: true, patch: '@@ -0,0 +1,2 @@\n+one\n+two' },
  { path: 'big.txt', status: 'added', additions: 400, deletions: 0, patch: patchOf(400) },
  { path: 'cut.txt', status: 'modified', additions: 1, deletions: 0, truncated: true, patch: '@@ -1 +1,2 @@\n a\n+b' },
  { path: 'src/env.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1,2 @@\n x\n+y', extra: 'dropped' },
  { status: 'modified' },
];

const many = Array.from({ length: 105 }, (_, i) => ({ path: `f${i}`, patch: '+' }));

const views: Array<[string, unknown]> = [
  [
    'workspace:gitStatus',
    {
      workspaceId: WS, repo: true, branch: 'feat', head: 'abc1234', dirtyCount: 3, ahead: 1, behind: 2, updatedAt: 5,
      worktree: { name: 'feat-wt', path: '/Users/me/.nekko/worktrees/feat-wt' },
      pr: { url: URL, owner: 'o', repo: 'r', number: 7, title: 'Feat', state: 'open', isDraft: false, additions: 1, deletions: 2, changedFiles: 3, checks: 'passing', source: 'gh', headRefName: 'feat' },
    },
  ],
  ['workspace:gitStatus', { workspaceId: WS, repo: false, dirtyCount: 0, ahead: 0, behind: 0, updatedAt: 5 }],
  ['workspace:gitStatus', null],
  ['git:diff', { files, truncated: false }],
  ['git:diff', { files: many, truncated: false }],
  ['git:diff', { files: [], truncated: true }],
  ['git:diff', 'nope'],
  ['pr:diff', { url: URL, files: files.slice(0, 2), truncated: false }],
  ['git:show', { commit: { ...commit('a', 'First'), body: `Body\n${'b'.repeat(4100)}` }, files: files.slice(0, 3), truncated: false }],
  ['git:log', [commit('a', 'First'), commit('b', 'Second'), 'junk']],
  ['git:log', Array.from({ length: 105 }, (_, i) => ({ sha: `${i}`, author: 'A', email: 'e', subject: '' }))],
  ['git:log', null],
  [
    'git:compare',
    {
      base: 'main', head: 'feat', mergeBase: 'm'.repeat(40), ahead: 2, behind: 1,
      commits: [commit('c', 'On feat')],
      files: [{ path: 'src/a.ts', status: 'modified', additions: 1, deletions: 1 }, { path: '.npmrc', status: 'added', additions: 1, deletions: 0 }],
      truncated: false,
    },
  ],
  [
    'git:branches',
    {
      current: 'feat', detached: false, head: 'abc1234', defaultBranch: 'main',
      local: [
        { name: 'feat', sha: 'abc1234', date: 'd', subject: 's', current: true, upstream: 'origin/feat', ahead: 1, behind: 0 },
        { name: 'main', sha: 'def5678', date: 'd', subject: 's', current: false, gone: true, secret: 'x' },
      ],
      remote: Array.from({ length: 203 }, (_, i) => ({ name: `b${i}`, x: 1 })),
    },
  ],
  [
    'pr:checks',
    {
      url: URL, checks: 'failing', source: 'gh',
      items: [
        { name: 'build', state: 'fail', workflow: 'CI', link: 'https://github.com/o/r/actions/runs/1', description: null, startedAt: 'a', completedAt: 'b', bucket: 'x' },
        { name: 'lint', state: 'pass', workflow: null, link: null, description: 'ok', startedAt: null, completedAt: null },
      ],
    },
  ],
  ['git:commitMessage', { message: 'Fix it\n\nBecause.', inputTruncated: false, model: 'm1' }],
  ['git:commit', { ok: true, message: 'Committed.', branch: 'feat', commit: commit('d', 'Fix it') }],
  ['git:commit', { ok: false, message: `fatal: ${'x'.repeat(4100)}` }],
  ['git:stage', { ok: true, message: 'Staged 2 files.', extra: 1 }],
  ['git:unstage', { ok: true, message: 'Unstaged.' }],
  ['git:push', { ok: true, message: 'Pushed.', branch: 'feat', remote: 'origin', upstream: 'origin/feat', url: 'https://token@github.com' }],
  ['git:switch', { ok: true, message: 'Switched.', branch: 'feat' }],
  ['git:mergeAbort', { ok: false, message: 'No merge to abort.' }],
  ['pr:create', { ok: true, message: 'Opened.', url: URL, pr: { url: URL, number: 7, title: 'Feat', state: 'open', isDraft: true, owner: 'o', checks: 'pending', additions: 0, deletions: 0, changedFiles: 0 } }],
  ['pr:action', { ok: true, message: 'Merged.', pr: { url: URL, number: 7, state: 'merged', title: 'Feat', headRefName: 'feat' } }],
];

function screenCase(channel: string, args: unknown[]) {
  try {
    return { channel, args, callArgs: screenPhoneCall(channel, args).callArgs ?? null };
  } catch (e) {
    if (!(e instanceof PhoneAccessError)) throw e;
    return { channel, args, error: e.message };
  }
}

it('writes the git cases the daemon is held to', () => {
  const golden = {
    screens: screens.map(([c, a]) => screenCase(c, a)),
    views: views.map(([channel, result]) => ({ channel, result, view: redactPhoneResult(channel, result) ?? null })),
  };
  // One case per line: reviewable, without the bulk of an indented file.
  const lines = (list: unknown[]) => list.map((c) => JSON.stringify(c)).join(',\n');
  const text = `{"screens":[\n${lines(golden.screens)}\n],"views":[\n${lines(golden.views)}\n]}\n`;
  if (process.env.UPDATE_GOLDEN) writeFileSync(path, text);
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(JSON.parse(text));
});
