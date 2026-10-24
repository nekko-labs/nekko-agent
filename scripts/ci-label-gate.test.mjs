import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { LABEL_WORKFLOWS, groupPrNumbers, labelRuns, needsMacos, queueBlockers } from './ci-label-gate.mjs';

const run = (id, path, status, conclusion = null) => ({ id, name: path.split('/').pop(), path, status, conclusion, html_url: `https://example/${id}` });
const ios = '.github/workflows/ios-native.yml';
const mobile = '.github/workflows/mobile.yml';

test('waits on the newest run of each label workflow, ignoring others', () => {
  const state = labelRuns([
    run(1, ios, 'completed', 'skipped'), // opened, before the label
    run(2, ios, 'queued'), // labelled: the real run
    run(3, mobile, 'completed', 'success'),
    run(4, '.github/workflows/ci.yml', 'in_progress'), // gate's own workflow
    run(5, '.github/workflows/auto-merge.yml', 'in_progress'), // waits on gate
  ]);
  assert.deepEqual(state.pending.map(r => r.id), [2]);
  assert.deepEqual(state.passed.map(r => r.id), [3]);
  assert.deepEqual(state.failed, []);
});

test('a failed or cancelled run fails; skipped and neutral pass', () => {
  const state = labelRuns([
    run(1, ios, 'completed', 'failure'),
    run(2, mobile, 'completed', 'cancelled'),
    run(3, '.github/workflows/codeql.yml', 'completed', 'neutral'),
    run(4, '.github/workflows/dev-identity.yml', 'completed', 'skipped'),
  ]);
  assert.deepEqual(state.failed.map(r => r.id), [1, 2]);
  assert.deepEqual(state.passed.map(r => r.id), [3, 4]);
});

test('a re-run that passed replaces the failed one', () => {
  assert.deepEqual(labelRuns([run(1, ios, 'completed', 'failure'), run(7, ios, 'completed', 'success')]).failed, []);
});

test("a group's PRs come from its squashed commit subjects", () => {
  assert.deepEqual(groupPrNumbers([
    'iPhone chat list: open short groups (#1001)\n\n- body (#5)',
    'Add phone safety exits (SK-3) (#994)',
    'A commit with no PR number',
    'Again (#994)',
  ]), [1001, 994]);
});

test('drafts and hold block the group; ci:macos is read from either label shape', () => {
  const prs = [
    { number: 1, isDraft: true, labels: { nodes: [] } },
    { number: 2, isDraft: false, labels: { nodes: [{ name: 'hold' }] } },
    { number: 3, isDraft: false, labels: [{ name: 'ci:macos' }] },
  ];
  assert.deepEqual(queueBlockers(prs), ['#1 is a draft.', '#2 is labelled `hold`.']);
  assert.deepEqual(prs.filter(needsMacos).map(pr => pr.number), [3]);
});

test('every listed workflow exists and is switched on by ci:macos', () => {
  for (const path of LABEL_WORKFLOWS) {
    assert.match(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'), /ci:macos/, path);
  }
});

test('gate runs the check on PRs and in the queue, and CI re-runs when a label is added', () => {
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(ci, /types: \[opened, synchronize, reopened, labeled\]/);
  assert.match(ci, /ci-label-gate\.mjs pr /);
  assert.match(ci, /ci-label-gate\.mjs queue /);
});
