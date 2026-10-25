import assert from 'node:assert/strict';
import { test } from 'node:test';
import { batchCandidates, batchMessage, iosVerdict, largestCompatible, parseBatch } from './ios-batch.mjs';

const pr = (number, { labels = ['ci:macos'], files = ['apps/ios/App/AppModel.swift'], ...rest } = {}) =>
  ({ number, headRefOid: String(number).padStart(40, 'a'), isDraft: false, isCrossRepository: false, baseRefName: 'main',
    labels: labels.map(name => ({ name })), files: files.map(path => ({ path })), ...rest });

test('a batch takes ready ci:macos iOS PRs into main, oldest first', () => {
  const prs = [
    pr(1012), pr(980),
    pr(1001, { labels: [] }), // no ci:macos
    pr(1002, { labels: ['ci:macos', 'hold'] }),
    pr(1003, { isDraft: true }),
    pr(1004, { isCrossRepository: true }), // a fork: no write token to report on
    pr(1005, { baseRefName: 'ci/ios-faster' }), // a stacked layer
    pr(1006, { files: ['docs/guide.md'] }), // nothing Native iOS tests
    pr(1007, { files: ['crates/nekkod/src/remote.rs'] }),
  ];
  assert.deepEqual(batchCandidates(prs).map(p => p.number), [980, 1007, 1012]);
});

test('the batch commit names its heads and reads back', () => {
  const included = [pr(980), pr(1012)];
  const message = batchMessage(included);
  assert.match(message, /^Native iOS batch: #980, #1012\n/);
  assert.deepEqual(parseBatch(message), included.map(({ number, headRefOid }) => ({ number, headRefOid })));
  assert.deepEqual(parseBatch('Some other commit'), []);
});

test('either a run on the PR or a batch status can pass it', () => {
  const run = (status, conclusion = null) => ({ status, conclusion });
  const status = state => ({ state });
  assert.equal(iosVerdict({ run: run('completed', 'failure'), status: status('success') }), 'passed');
  assert.equal(iosVerdict({ run: run('completed', 'success'), status: status('failure') }), 'passed');
  assert.equal(iosVerdict({ run: run('in_progress'), status: status('failure') }), 'pending');
  assert.equal(iosVerdict({ status: status('pending') }), 'pending');
  assert.equal(iosVerdict({ status: status('failure') }), 'failed');
  assert.equal(iosVerdict({ status: status('error') }), 'failed');
  // Nothing yet: wait only when the PR needs Native iOS.
  assert.equal(iosVerdict({ required: true }), 'pending');
  assert.equal(iosVerdict({ required: false }), 'none');
});

test('the batch is the largest set of PRs that merge with each other, oldest first on a tie', () => {
  // 0 clashes with everyone (the live case on 2026-10-24: #1011); 2 and 3 get along.
  const conflicts = new Set(['0,1', '0,2', '0,3', '1,2', '1,3']);
  assert.deepEqual(largestCompatible(4, conflicts), [2, 3]);
  assert.deepEqual(largestCompatible(3, new Set()), [0, 1, 2]);
  assert.deepEqual(largestCompatible(3, new Set(['0,1', '1,2', '0,2'])), [0]);
  assert.deepEqual(largestCompatible(0, new Set()), []);
});
