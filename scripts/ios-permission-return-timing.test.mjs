// These source/negative contracts do not compile Swift or certify native timing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../apps/ios/UITests/PermissionReturnTimingTests.swift', import.meta.url), 'utf8');
const workflow = fs.readFileSync(new URL('../.github/workflows/native-mode-evidence.yml', import.meta.url), 'utf8');

function contract(text) {
  for (const required of [
    'try XCTSkipUnless(ProcessInfo.processInfo.environment["NEKKO_EVIDENCE_BASELINE"] != nil,',
    'let row = app.descendants(matching: .any)["permissions.row.microphone"].firstMatch',
    'let expandable = row.elementType == .button',
    'let target = expandable ? row : microphone',
    'if expandable { row.tap() }',
    'guard target.exists && target.isHittable else',
    'XCTAssertTrue(microphone.label.hasPrefix("Allow"),',
    'XCTAssertTrue(alert.waitForExistence(timeout: 10))',
    'deny.tap()',
    'XCTAssertTrue(microphone.label.hasPrefix("Settings:"))',
    'XCTAssertEqual(toggle.value as? String, "0")',
    'NSPredicate(format: "value == %@", "1")',
    'let resumeState = app.state',
    'let returnBudget: TimeInterval = 10',
    'let returnStarted = ProcessInfo.processInfo.systemUptime',
    'app.activate()',
    'let activationElapsed = ProcessInfo.processInfo.systemUptime - returnStarted',
    'let remaining = max(0, returnBudget - activationElapsed)',
    'let result = XCTWaiter.wait(for: [restored], timeout: remaining)',
    'let allowedElapsed = ProcessInfo.processInfo.systemUptime - returnStarted',
    'XCTAssertEqual(result, .completed,',
    'XCTAssertLessThanOrEqual(allowedElapsed, returnBudget,',
    'NSPredicate(format: "exists == true AND label == %@", "Allowed")',
    'XCTAssertTrue(microphoneStatus.exists,',
    'XCTAssertEqual(microphoneStatus.label, "Allowed")',
    'process.name = "permissions-settings-return-timing"',
    'hierarchy.name = "permissions-settings-return-accessibility"',
  ]) assert.ok(text.includes(required), required);
  assert.equal((text.match(/let returnStarted =/g) || []).length, 1);
  const timed = text.slice(text.indexOf('let returnStarted ='), text.indexOf('XCTAssertLessThanOrEqual(allowedElapsed'));
  assert.ok(timed.indexOf('app.activate()') > timed.indexOf('systemUptime'));
  assert.ok(!/attach\(|debugDescription|XCTAttachment|waitForExistence|app\.launch\(|resumeState\s*==/.test(timed), 'no diagnostics, extra waits or conditional return in timed interval');
  assert.equal((text.match(/app\.activate\(\)/g) || []).length, 1);
  const returning = text.slice(text.indexOf('let resumeState ='));
  assert.ok(!/app\.launch\(|resumeState\s*==|app\.terminate\(/.test(returning), 'same return action without forced process state');
  assert.ok(!/simctl|privacy grant|[.]setAuthorization/.test(text), 'no synthetic grants');
}

test('common native driver has one end-to-end ten-second monotonic budget', () => contract(source));

test('rejects missing denial, real Settings change, Allowed or total timing assertions', () => {
  for (const needle of ['deny.tap()', 'XCTAssertEqual(toggle.value as? String, "0")',
    'NSPredicate(format: "value == %@", "1")', 'NSPredicate(format: "exists == true AND label == %@", "Allowed")',
    'XCTAssertEqual(result, .completed,', 'XCTAssertLessThanOrEqual(allowedElapsed, returnBudget,',
    'let returnBudget: TimeInterval = 10']) {
    assert.throws(() => contract(source.replace(needle, '// removed')));
  }
});

test('rejects a late clock, pre-assertion diagnostic capture or extra wait budget', () => {
  assert.throws(() => contract(source.replace('        app.activate()', '        attach(app, "late")\n        app.activate()')));
  assert.throws(() => contract(source.replace('timeout: remaining', 'timeout: 10')));
  assert.throws(() => contract(source.replace('        app.activate()', '        app.activate()\n        let returnStarted = ProcessInfo.processInfo.systemUptime')));
  assert.throws(() => contract(source.replace('        app.activate()', '        if resumeState == .notRunning { app.launch() } else { app.activate() }')));
});

test('opt-in matched workflow retains recording, strict runtime and no retries', () => {
  assert.ok(workflow.includes('"$IOS_TEST_FILE" == "apps/ios/UITests/PermissionReturnTimingTests.swift"'));
  assert.ok(workflow.includes('VIDEO_NAME=permission-return'));
  assert.ok(workflow.includes('recordVideo --codec=h264 "evidence/$VIDEO_NAME.mp4"'));
  assert.ok(workflow.includes('test -n "$RUNTIME" && test -n "$TYPE"'));
  assert.ok(!workflow.includes('-retry-tests-on-failure'));
});
