import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { capture, cleanup, DEVICE_TYPE, RUNTIME, selectXcode, TEST_FILE, validate } from './ios-turn-details-diagnostic.mjs';

const pins = { app: 'a'.repeat(40), harness: 'b'.repeat(40) };
const context = { event: 'workflow_dispatch', ref: 'refs/heads/main', environment: 'self-hosted' };
const inputs = { turn_details_diagnostic: JSON.stringify(pins), batch: '', attention_evidence: false };
const workflow = readFileSync(new URL('../.github/workflows/ios-native.yml', import.meta.url), 'utf8');

test('only immutable app/harness pins on approved owner-runner dispatches', () => {
  for (const ref of ['refs/heads/main', 'refs/heads/ci/ios-batch']) assert.deepEqual(validate(inputs, { ...context, ref }), pins);
  for (const change of [{ event: 'pull_request' }, { ref: 'refs/heads/feature' }, { environment: 'github-hosted' }]) {
    assert.throws(() => validate(inputs, { ...context, ...change }));
  }
  for (const value of ['{}', '[]', 'null', 'oops', JSON.stringify({ ...pins, app: 'main' }),
    JSON.stringify({ ...pins, app: 'a'.repeat(40) + '\nx=y' }), JSON.stringify({ ...pins, testFile: '../App.swift' })]) {
    assert.throws(() => validate({ ...inputs, turn_details_diagnostic: value }, context));
  }
  for (const key of ['batch', 'baseline_ref', 'source_ref', 'relay_baseline_ref', 'attention_evidence']) {
    assert.throws(() => validate({ ...inputs, [key]: key === 'attention_evidence' ? true : pins.app }, context));
  }
});

test('exact Xcode build is required, not a matching minor version or default', () => {
  assert.equal(selectXcode(['old', 'right'], p => p === 'right' ? 'Xcode 27.2\nBuild version 27B52\n' : 'Xcode 27.1\nBuild version 27A9275'), 'right');
  for (const version of ['Xcode 27.1\nBuild version 27A9275', 'Xcode 27.2\nBuild version wrong']) {
    assert.throws(() => selectXcode(['one'], () => version));
  }
});

function fixture(mode) {
  const cwd = process.cwd();
  const root = mkdtempSync(join(tmpdir(), 'turn-details-workflow-'));
  process.chdir(root);
  mkdirSync('source/apps/ios/UITests', { recursive: true });
  mkdirSync('Applications/Xcode.app', { recursive: true });
  writeFileSync('source/apps/ios/production.swift', 'production unchanged');
  const calls = [];
  const run = (cmd, args, options = {}) => {
    calls.push({ cmd, args, options });
    if (cmd === 'git') return args.includes('show') ? 'test-only harness' : args.includes('source') ? pins.app : pins.harness;
    if (cmd === 'xcodebuild' && args.includes('-version')) return 'Xcode 27.2\nBuild version 27B52\n';
    if (args.includes('runtimes')) return JSON.stringify({ runtimes: [{ isAvailable: true, identifier: RUNTIME, buildversion: mode === 'runtime' ? 'wrong' : '24B8117' }] });
    if (args.includes('create')) return '00000000-0000-0000-0000-000000000001\n';
    if (mode === 'bootstrap-failure' && cmd === 'brew') throw new Error('XcodeGen installation failed');
    if (mode === 'tool-check-failure' && cmd === 'xcodegen' && args.includes('--version')) throw new Error('XcodeGen unavailable on PATH');
    if (mode === 'build-failure' && args.includes('build-for-testing')) throw new Error('native build failed');
    if (args.includes('test-without-building')) {
      if (mode === 'missing-result') return '';
      mkdirSync('diagnostic-evidence/turn-details.xcresult');
      if (mode === 'test-failure') throw new Error('native scroll assertion');
    }
    if (args.includes('summary')) {
      if (mode === 'test-failure') throw new Error('secondary export error');
      return JSON.stringify({ totalTestCount: 8, passedTests: mode === 'skip' ? 7 : 8, failedTests: 0, skippedTests: mode === 'skip' ? 1 : 0 });
    }
    if (args.includes('attachments')) {
      if (mode === 'export-failure') throw new Error('attachments export failed');
      mkdirSync('diagnostic-evidence/shots');
      if (mode === 'missing-pixels') return '';
      writeFileSync('diagnostic-evidence/shots/native.png', 'mock pixels, not visual evidence');
    }
    return '';
  };
  try {
    if (mode === 'success') capture(pins, run, join(root, 'Applications'));
    else assert.throws(() => capture(pins, run, join(root, 'Applications')), ({ 'test-failure': /native scroll assertion/, skip: /eight/, runtime: /runtime required/, 'bootstrap-failure': /XcodeGen installation failed/, 'tool-check-failure': /XcodeGen unavailable on PATH/, 'build-failure': /native build failed/, 'missing-result': /summary.json/, 'missing-pixels': /screenshots missing/, 'export-failure': /attachments export failed/ })[mode]);
    assert.equal(readFileSync('source/apps/ios/production.swift', 'utf8'), 'production unchanged');
    if (!['runtime', 'bootstrap-failure', 'tool-check-failure'].includes(mode)) {
      const install = calls.findIndex(c => c.cmd === 'brew' && c.args.join(' ') === 'install xcodegen');
      const version = calls.findIndex(c => c.cmd === 'xcodegen' && c.args.join(' ') === '--version');
      const packages = calls.findIndex(c => c.cmd === 'swift');
      const generate = calls.findIndex(c => c.cmd === 'xcodegen' && c.args.join(' ') === 'generate');
      const create = calls.findIndex(c => c.args.includes('create'));
      assert.ok(install >= 0 && install < version && version < packages && packages < generate && generate < create);
      for (const index of [install, version]) {
        assert.equal(calls[index].options.cwd, realpathSync(join(root, 'source/apps/ios')));
        assert.equal(calls[index].options.stdio[0], 'ignore');
        assert.equal(calls[index].options.stdio[1], calls[index].options.stdio[2]);
      }
      assert.equal(readFileSync(join('source', TEST_FILE), 'utf8'), 'test-only harness');
      const tests = calls.find(c => c.args.includes('test-without-building'));
      if (mode !== 'build-failure') {
        assert.deepEqual(tests.args.filter(a => a.startsWith('-only-testing:')), ['-only-testing:NekkoNativeUITests/TurnDetailsTests']);
        assert.ok(tests.options.env.DEVELOPER_DIR.endsWith('Xcode.app/Contents/Developer'));
      }
      for (const action of ['shutdown', 'delete']) assert.ok(calls.some(c => c.args[0] === 'simctl' && c.args[1] === action));
      if (!['build-failure', 'missing-result'].includes(mode)) assert.ok(calls.some(c => c.args.includes('export')));
      cleanup(run);
    } else {
      assert.ok(!calls.some(c => c.args.includes('create')));
      assert.ok(!calls.some(c => c.cmd === 'swift' || c.args.includes('generate')));
      assert.match(readFileSync('diagnostic-evidence/failure.txt', 'utf8'), /runtime required|XcodeGen/);
      assert.match(readFileSync('diagnostic-evidence/revisions.txt', 'utf8'), new RegExp(pins.app));
      assert.ok(readFileSync('diagnostic-evidence/host.txt', 'utf8').includes('Xcode 27.2'));
      if (mode !== 'runtime') assert.ok(readFileSync('diagnostic-evidence/runtimes.json', 'utf8').includes('24B8117'));
    }
  } finally { process.chdir(cwd); rmSync(root, { recursive: true, force: true }); }
}
for (const mode of ['success', 'test-failure', 'runtime', 'bootstrap-failure', 'tool-check-failure', 'skip', 'build-failure', 'missing-result', 'missing-pixels', 'export-failure']) test(`capture ${mode}: preserve verdict, production and owned-device cleanup`, () => fixture(mode));

test('workflow isolates diagnostics from normal shards, evidence dispatches and batch statuses', () => {
  const diagnostic = workflow.split('  turn-details-diagnostic:\n')[1].split('  protocol-and-build:\n')[0];
  assert.match(workflow, /group:.*inputs.turn_details_diagnostic && format\('turn-details-\{0\}', github.run_id\)/);
  const contracts = readFileSync(new URL('../.github/workflows/turn-details-contracts.yml', import.meta.url), 'utf8');
  assert.match(contracts, /diagnostic-contracts:[\s\S]*?runs-on: ubuntu-latest[\s\S]*?node --test scripts\/ios-turn-details-diagnostic.test.mjs/);
  assert.match(diagnostic, /permissions:\n      contents: read/);
  assert.match(diagnostic, /test "\$RUNNER_ENVIRONMENT" = self-hosted/);
  assert.ok(diagnostic.indexOf('Require approved') < diagnostic.indexOf('actions/checkout'));
  assert.match(diagnostic, /ref: \$\{\{ github.sha \}\}/);
  assert.match(diagnostic, /if: always\(\)/);
  assert.doesNotMatch(diagnostic, /statuses: write|report-batch|ios-suite-shards.mjs report/);
  assert.match(workflow, /protocol-and-build:[\s\S]*?if: \$\{\{ !inputs.turn_details_diagnostic/);
  assert.match(workflow, /report-batch:[\s\S]*?if: always\(\) && inputs.batch && !inputs.turn_details_diagnostic/);
  assert.equal((workflow.match(/!inputs.turn_details_diagnostic && inputs\./g) ?? []).length, 7);
  // Infrastructure only: the normal matrix's commands stay byte-identical.
  const matrix = s => s.split('  protocol-and-build:\n')[1].split('    steps:\n')[1].split('  report-batch:\n')[0];
  // SHA256 of default matrix commands, last changed for the quarantine list (#3094); changes need deliberate review.
  assert.equal(createHash('sha256').update(matrix(workflow)).digest('hex'), '1f33f868e2d3a91402a404700b8260d8a261a2eae37ce91849b41c4d15dfcb71');
  assert.equal(DEVICE_TYPE, 'com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro');
});
