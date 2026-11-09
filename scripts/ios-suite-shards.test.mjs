import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SUITE_SHARDS, batchState, reportBatch, validateShard } from './ios-suite-shards.mjs';

const workflow = readFileSync(new URL('../.github/workflows/ios-native.yml', import.meta.url), 'utf8');
const suiteJob = workflow.split('  protocol-and-build:\n')[1].split('  report-batch:\n')[0];
const reportJob = workflow.split('  report-batch:\n')[1];
const shardBody = name => {
  const match = suiteJob.match(new RegExp(`^          if \\[ "\\$SHARD" = ${name} \\]; then\\n([\\s\\S]*?)^          fi$`, 'm'));
  assert.ok(match, `Missing guarded ${name} suite`);
  return match[1];
};
const selectors = body => body.match(/-(?:only|skip)-testing:[\w/]+/g) ?? [];
const live = 'NekkoNativeUITests/LiveRelayTests';
// The pre-shard workflow's exact selection. Keep the fixture suite open-ended:
// listing today's fixture classes would silently omit the next added suite.
const originalSelectors = [
  `-skip-testing:${live}`,
  ...['testPairStreamAndApproveFromThePhone', 'testSendWithTheRelayDownAndSeeItDelivered',
    'testQueueForkAutomationsAndUsageFromThePhone', 'testSimpleAndExpertModes',
    'testPlanSheetBehindTheComposer', 'testFollowUpInASubagent',
    'testChatsOnTheComputerAndOnThisIPhoneInOneList', 'testPairFromADeepLink'].map(name => `-only-testing:${live}/${name}`),
];

test('shard selector union equals the original selection without duplicates or stray invocations', () => {
  const assigned = SUITE_SHARDS.flatMap(name => selectors(shardBody(name)));
  assert.deepEqual(assigned, originalSelectors);
  assert.deepEqual(selectors(suiteJob), assigned, 'No selector may run outside a shard guard');
  assert.equal(new Set(assigned).size, assigned.length);
  assert.deepEqual(selectors(shardBody('pairing')), [originalSelectors[1]]);
  assert.deepEqual(selectors(shardBody('journeys')), originalSelectors.slice(2));
});

test('fixtures still select ALL unit/UI suites except live tests, including future suites', () => {
  const fixture = shardBody('fixtures');
  assert.deepEqual(selectors(fixture), [`-skip-testing:${live}`]);
  assert.doesNotMatch(fixture, /-only-testing:|-skip-testing:(?!NekkoNativeUITests\/LiveRelayTests)/);
  // XCTest's target/class prefix semantics: adding a non-live suite needs no CI edit.
  const selected = test => !test.startsWith(`${live}/`);
  for (const name of ['NekkoNativeTests/NewUnitTests/testFuture', 'NekkoNativeUITests/NewFixtureTests/testFuture', 'FutureTestTarget/FutureSuite/testFuture']) {
    assert.ok(selected(name), name);
  }
  assert.equal(selected(`${live}/testFutureLiveJourney`), false);
  assert.match(fixture, /TEST_RUNNER_NEKKO_UI_THEMES="\$THEMES"/);
  assert.match(fixture, /-retry-tests-on-failure -test-iterations 2 \|\| failed=1/);
  assert.match(fixture, /-parallel-testing-worker-count "\$WORKERS"/);
  assert.match(fixture, /\[ "\$WORKERS" -gt 4 \] && WORKERS=4/);
});

test('pairing retains every scoped theme and both fresh-stack attempts; other journeys remain serial', () => {
  const pairing = shardBody('pairing');
  assert.match(pairing, /for THEME in \$THEMES; do/);
  assert.match(pairing, /for try in 1 2; do/);
  assert.match(pairing, /TEST_RUNNER_NEKKO_ITEST_THEME="\$THEME"/);
  assert.match(pairing, /journey=1; continue/);
  assert.match(pairing, /failed=\$\(\(failed \| journey\)\)/);
  assert.equal((pairing.match(/itest-stack\.sh/g) ?? []).length, 1);
  assert.equal((shardBody('journeys').match(/itest-stack\.sh/g) ?? []).length, 7);
  assert.doesNotMatch(shardBody('journeys'), /&\s*$/m, 'Live stacks must not run in parallel');
  assert.match(shardBody('journeys'), /appearance light/);
  assert.match(suiteJob, /exit \$failed/);
  assert.match(suiteJob, /stack_logs\(\).*tail -n 120/);
});

test('unknown shard and command inputs are refused, never treated as an empty successful shard', () => {
  for (const shard of SUITE_SHARDS) assert.equal(validateShard(shard), shard);
  for (const shard of ['', 'all', 'fixture', 'Fixtures', undefined, null]) assert.throws(() => validateShard(shard), /Unknown/);
  const script = fileURLToPath(new URL('./ios-suite-shards.mjs', import.meta.url));
  for (const args of [['shard', 'all'], ['shard'], ['shard', 'fixtures', 'extra'], ['unknown']]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, args.join(' '));
    assert.equal(result.stdout, '');
  }
  assert.equal(spawnSync(process.execPath, [script, 'shard', 'fixtures']).status, 0);
});

const batch = JSON.stringify([{ number: 2035, sha: 'a'.repeat(40) }, { number: 2036, sha: 'b'.repeat(40) }]);
const inputs = { batch, repository: 'owner/repo', sha: 'c'.repeat(40), url: 'https://example.test/run/1' };
const states = calls => calls.filter(args => args.includes('POST')).map(args => args.find(arg => arg.startsWith('state=')));

test('aggregate report is fail-closed for failure, cancellation, skipped, missing and unknown results', () => {
  for (const [result, expected] of [
    ['success', 'success'], ['failure', 'failure'], ['cancelled', 'error'], ['skipped', 'failure'],
    ['pending', 'failure'], ['in_progress', 'failure'], ['timed_out', 'failure'], ['neutral', 'failure'],
    ['', 'failure'], [undefined, 'failure'], [null, 'failure'], [{ fixtures: 'success' }, 'failure'],
  ]) {
    const calls = [];
    const outcome = reportBatch({ ...inputs, result }, args => { calls.push(args); return inputs.sha; });
    assert.equal(batchState(result), expected);
    assert.deepEqual(outcome, { state: expected, reported: 2, superseded: false });
    assert.deepEqual(states(calls), [`state=${expected}`, `state=${expected}`]);
    for (const args of calls.filter(args => args.includes('POST'))) {
      assert.ok(args.includes('context=Native iOS (batch)'));
      assert.ok(args.includes(`target_url=${inputs.url}`));
      assert.ok(args.some(arg => arg.endsWith('on the batch #2035, #2036')));
    }
  }
});

test('a superseded cancelled batch leaves newer statuses alone; API failures never become success', () => {
  const calls = [];
  assert.deepEqual(reportBatch({ ...inputs, result: 'cancelled' }, args => { calls.push(args); return 'd'.repeat(40); }),
    { state: 'error', reported: 0, superseded: true });
  assert.deepEqual(calls, [['api', 'repos/owner/repo/git/ref/heads/ci/ios-batch', '--jq', '.object.sha']]);
  for (const result of ['success', 'failure', 'cancelled']) {
    assert.throws(() => reportBatch({ ...inputs, result }, () => { throw new Error('API unavailable'); }), /API unavailable/);
  }
});

test('invalid batch input is rejected in full before any status write', () => {
  const uncalled = () => assert.fail('No requests for invalid input');
  for (const value of ['', 'not JSON', '{}', '[]', '[null]', JSON.stringify([{ number: 0, sha: 'a'.repeat(40) }]),
    JSON.stringify([{ number: 1, sha: 'a'.repeat(40) }, { number: 2, sha: 'bad' }])]) {
    assert.throws(() => reportBatch({ ...inputs, batch: value, result: 'success' }, uncalled));
  }
});

test('workflow requires the complete non-fail-fast matrix before the sole batch reporter', () => {
  const matrix = suiteJob.match(/shard: \[([^\]]+)\]/)[1].split(', ');
  assert.deepEqual(matrix, SUITE_SHARDS);
  assert.match(suiteJob, /fail-fast: false/);
  assert.doesNotMatch(suiteJob, /continue-on-error:|exclude:|include:/);
  assert.match(suiteJob, /timeout-minutes: 85/);
  assert.match(suiteJob, /SHARD: \$\{\{ matrix.shard \}\}/);
  assert.match(suiteJob, /run: node scripts\/ios-suite-shards.mjs shard "\$SHARD"/);
  assert.ok(suiteJob.indexOf('Validate suite shard') < suiteJob.indexOf('Protocol and app-state tests'));
  assert.match(suiteJob, /needs: pick/);
  assert.match(suiteJob, /!cancelled\(\)/, 'A skipped picker must not skip the matrix');
  assert.match(reportJob, /needs: protocol-and-build/);
  assert.match(reportJob, /if: always\(\) && inputs.batch/);
  assert.match(reportJob, /RESULT: \$\{\{ needs.protocol-and-build.result \}\}/);
  assert.doesNotMatch(reportJob, /job.status|continue-on-error:/);
  assert.doesNotMatch(suiteJob, /ios-suite-shards.mjs report|statuses\/|Report the batch/);
  assert.equal((workflow.match(/run: node scripts\/ios-suite-shards.mjs report/g) ?? []).length, 1);
});

test('theme scope, audits, screenshot export and distinct per-shard artifacts remain wired', () => {
  assert.match(suiteJob, /github.event_name == 'schedule'.*workflow_dispatch.*!inputs.batch.*ci:theme/);
  assert.match(suiteJob, /git diff HEAD\^1 HEAD -- apps\/ios \| node scripts\/ios-theme-scope.mjs/);
  for (const audit of ['run: swift test', 'node scripts/vendor-mermaid.mjs --check', 'cargo build -p nekkod --locked',
    'run: apps/ios/scripts/itest.sh', 'plutil -lint', 'build-for-testing', 'Verify bundle']) {
    assert.ok(suiteJob.includes(audit), audit);
  }
  assert.match(suiteJob, /Export screenshots from the test results\n        if: always\(\)/);
  assert.match(suiteJob, /xcresulttool export attachments/);
  assert.match(suiteJob, /uses: actions\/upload-artifact@v7\n        if: always\(\)/);
  assert.match(suiteJob, /name: native-ios-evidence-\$\{\{ matrix.shard \}\}/);
  assert.match(suiteJob, /apps\/ios\/evidence\/shots\/\*\*/);
  assert.match(suiteJob, /trap 'xcrun simctl shutdown.*simctl delete.*kill/);
});
