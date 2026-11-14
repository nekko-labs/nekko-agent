import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { exportFailureDiagnostics } from './ios-failure-diagnostics.mjs';

function fixture(t, names) {
  const root = mkdtempSync(join(tmpdir(), 'nekko-ios-diagnostics-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of names) mkdirSync(join(root, name));
  return root;
}

function runner(summaries, calls, exportError = false) {
  return (command, args, options) => {
    assert.equal(command, 'xcrun');
    assert.ok(options.timeout > 0, 'a diagnostic command cannot hold a shard forever');
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    calls.push(args);
    const name = basename(args[args.indexOf('--path') + 1]);
    if (args.includes('summary')) {
      const summary = summaries[name];
      if (summary instanceof Error) throw summary;
      return JSON.stringify(summary);
    }
    if (exportError) throw new Error('diagnostic export timed out');
    const out = args[args.indexOf('--output-path') + 1];
    mkdirSync(join(out, 'test/simctl_diagnostics/DiagnosticReports'), { recursive: true });
    writeFileSync(join(out, 'test/testmanagerd.log'), 'test-specific log');
    writeFileSync(join(out, 'test/simctl_diagnostics/DiagnosticReports/unrelated.ips'), 'host-wide data');
    return '';
  };
}

test('retains failed first attempts separately and skips a clean retry', t => {
  const root = fixture(t, ['light-1.xcresult', 'light-2.xcresult', 'dark.xcresult', 'shots']);
  writeFileSync(join(root, 'not-a-directory.xcresult'), 'ignore');
  const calls = [];
  const failed = { result: 'Failed', failedTests: 1, testFailures: [{ testName: 'queue' }] };
  const outputs = exportFailureDiagnostics(root, {
    run: runner({ 'light-1.xcresult': failed, 'light-2.xcresult': { result: 'Passed', failedTests: 0 }, 'dark.xcresult': failed }, calls),
    log() {},
  });
  assert.deepEqual(outputs.map(p => basename(p)).sort(), ['dark', 'light-1']);
  const exports = calls.filter(a => a.includes('export'));
  assert.equal(exports.length, 2);
  assert.equal(readFileSync(join(root, 'diagnostics/light-1/xcode/test/testmanagerd.log'), 'utf8'), 'test-specific log');
  assert.equal(existsSync(join(root, 'diagnostics/light-1/xcode/test/simctl_diagnostics')), false, 'host-wide diagnostics never enter upload paths');
  for (const args of exports) assert.equal(existsSync(args[args.indexOf('--output-path') + 1]), false, 'raw staging is removed');
  assert.equal(calls.length, 5, 'three summaries, two diagnostic exports');
  assert.equal(JSON.parse(readFileSync(join(root, 'diagnostics/light-1/summary.json'))).failedTests, 1);
  assert.deepEqual(readdirSync(join(root, 'diagnostics')).sort(), ['dark', 'light-1']);
});

test('tries diagnostics for missing/incomplete/invalid test summaries', t => {
  for (const summary of [new Error('incomplete result'), null, { result: 'Failed', failedTests: 0 }]) {
    const root = fixture(t, ['launch.xcresult']);
    const calls = [];
    const outputs = exportFailureDiagnostics(root, { run: runner({ 'launch.xcresult': summary }, calls), log() {} });
    assert.equal(outputs.length, 1);
    assert.equal(calls.length, 2, 'summary failure must not hide app-launch diagnostics');
  }
});

test('records an export error without throwing or preventing later results', t => {
  const root = fixture(t, ['a.xcresult', 'b.xcresult']);
  const failed = { result: 'Failed', failedTests: 1 };
  const outputs = exportFailureDiagnostics(root, {
    run: runner({ 'a.xcresult': failed, 'b.xcresult': failed }, [], true), log() {},
  });
  assert.equal(outputs.length, 2);
  for (const out of outputs) assert.match(readFileSync(join(out, 'export-error.txt'), 'utf8'), /timed out/);
});

test('does not trust a passing label with recorded failures', t => {
  const root = fixture(t, ['inconsistent.xcresult']);
  const calls = [];
  exportFailureDiagnostics(root, { run: runner({ 'inconsistent.xcresult': { result: 'Passed', failedTests: 0, testFailures: [{}] } }, calls), log() {} });
  assert.equal(calls.length, 2);
});

test('empty result directory is safe', t => {
  const root = fixture(t, ['.xcresult', '..xcresult', '...xcresult']);
  assert.deepEqual(exportFailureDiagnostics(root, { run() { assert.fail('no xcrun needed'); } }), []);
  assert.deepEqual(exportFailureDiagnostics(join(root, 'missing'), { run() { assert.fail('no xcrun needed'); } }), []);
});

test('Native iOS uploads failure diagnostics without a new job or changed retries', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ios-native.yml', import.meta.url), 'utf8');
  assert.match(workflow, /node \.\.\/\.\.\/scripts\/ios-failure-diagnostics\.mjs evidence/);
  assert.match(workflow, /apps\/ios\/evidence\/diagnostics\/\*\*/);
});
