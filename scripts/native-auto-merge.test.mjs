import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { mergeAction, applyMergePolicy } from './native-auto-merge.mjs';

const repo = 'nekko-labs/nekko-agent';
const head = 'a'.repeat(40);
const good = () => ({ state: 'OPEN', isDraft: false, labels: [], baseRefName: 'main', isCrossRepository: false, headRepositoryOwner: { login: 'nekko-labs' }, headRefOid: head, mergeable: 'MERGEABLE', autoMergeRequest: null, statusCheckRollup: [{ name: 'gate', status: 'COMPLETED', conclusion: 'SUCCESS' }] });
const options = { repo, expectedHead: head };

test('only current same-repo main PRs with successful gate can auto-merge', () => {
  assert.equal(mergeAction(good(), options), 'enable');
  for (const patch of [{ isDraft: true }, { labels: [{ name: 'hold' }] }, { mergeable: 'CONFLICTING' }, { mergeable: 'UNKNOWN' }, { statusCheckRollup: [] }]) {
    assert.equal(mergeAction({ ...good(), ...patch }, options), 'disable', JSON.stringify(patch));
  }
  for (const patch of [{ state: 'MERGED' }, { state: 'CLOSED' }, { baseRefName: 'feature' }, { isCrossRepository: true }, { headRepositoryOwner: { login: 'someone' } }, { headRefOid: 'b'.repeat(40) }]) {
    assert.equal(mergeAction({ ...good(), ...patch }, options), 'ignore', JSON.stringify(patch));
  }
});

test('missing, pending, failed, cancelled or skipped gate fails closed even beside stale success', () => {
  for (const [status, conclusion] of [['IN_PROGRESS', null], ['QUEUED', null], ['COMPLETED', 'FAILURE'], ['COMPLETED', 'CANCELLED'], ['COMPLETED', 'SKIPPED'], ['COMPLETED', 'TIMED_OUT']]) {
    assert.equal(mergeAction({ ...good(), statusCheckRollup: [...good().statusCheckRollup, { name: 'gate', status, conclusion }] }, options), 'disable');
  }
});

test('enable uses protected native squash with exact-head guard, never admin or enqueue', () => {
  const calls = [];
  applyMergePolicy({ ...options, number: 1855, run: args => { calls.push(args); return JSON.stringify(good()); } });
  assert.deepEqual(calls[1], ['pr', 'merge', '1855', '--repo', repo, '--auto', '--squash', '--match-head-commit', head]);
});

test('hold/draft or failed gate disable already-armed auto-merge; inactive PRs cause no mutation', () => {
  for (const patch of [{ isDraft: true }, { labels: [{ name: 'hold' }] }, { statusCheckRollup: [] }]) {
    const calls = [];
    applyMergePolicy({ ...options, number: 1855, run: args => { calls.push(args); return JSON.stringify({ ...good(), ...patch, autoMergeRequest: {} }); } });
    assert.deepEqual(calls[1], ['pr', 'merge', '1855', '--repo', repo, '--disable-auto']);
  }
  const calls = [];
  applyMergePolicy({ ...options, number: 1855, run: args => { calls.push(args); return JSON.stringify({ ...good(), isDraft: true }); } });
  assert.equal(calls.length, 1);
});

test('workflow runs trusted main only, reconciles CI completion and hold/draft events, has no retry loop', () => {
  const yml = readFileSync(new URL('../.github/workflows/auto-merge.yml', import.meta.url), 'utf8');
  assert.match(yml, /pull_request_target:/);
  assert.match(yml, /workflow_run:\n    workflows: \[CI\]\n    types: \[completed\]/);
  for (const event of ['converted_to_draft', 'ready_for_review', 'labeled', 'unlabeled', 'synchronize']) assert.ok(yml.includes(event));
  assert.match(yml, /ref: main/);
  assert.match(yml, /persist-credentials: false/);
  assert.match(yml, /head.repo.full_name == github.repository/);
  assert.match(yml, /permission-contents: write/);
  assert.doesNotMatch(yml, /enqueuePullRequest|gh run rerun|gh stack merge|sleep /);
});

test('migration marker is fail-closed on migrated gate so old green results cannot merge', () => {
  const yml = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const marker = yml.split('\n  native-premerge:')[1];
  assert.ok(marker);
  assert.match(marker, /needs: gate/);
  assert.match(marker, /if: always\(\)/);
  assert.match(marker, /RESULT: \$\{\{ needs.gate.result \}\}/);
  assert.match(marker, /run: test "\$RESULT" = success/);
});

test('legacy queue workflows are manual-only and disabled; no automatic retries or Codex dispatch', () => {
  for (const file of ['queue-sweeper.yml', 'queue-repair.yml']) {
    const yml = readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8');
    assert.match(yml, /workflow_dispatch:/);
    assert.match(yml, /if: \$\{\{ false \}\}/);
    assert.doesNotMatch(yml, /schedule:|pull_request_target:|enqueuePullRequest|run rerun|CODEX_TOKEN/);
  }
});
