// These source/negative contracts do not compile Swift or certify native timing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { permissionReturnFixture } from './ios-permission-return-fixture.mjs';

const source = fs.readFileSync(new URL('../apps/ios/UITests/PermissionReturnTimingTests.swift', import.meta.url), 'utf8');
const workflow = fs.readFileSync(new URL('../.github/workflows/native-mode-evidence.yml', import.meta.url), 'utf8');
const appModel = fs.readFileSync(new URL('../apps/ios/App/AppModel.swift', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../apps/ios/App/NekkoApp.swift', import.meta.url), 'utf8');

function contract(text) {
  for (const required of [
    'try XCTSkipUnless(ProcessInfo.processInfo.environment["NEKKO_EVIDENCE_BASELINE"] != nil,',
    '"-uiTestPermissionReturnEvidence"',
    'let row = app.descendants(matching: .any)["permissions.row.microphone"].firstMatch',
    'let expandable = row.elementType == .button',
    'let target = expandable ? row : microphone',
    'if expandable { row.tap() }',
    'guard reveal(target, in: app) else { return }',
    'guard reveal(microphone, in: app) else { return }',
    'let viewport = scroll.frame.intersection(app.frame)',
    'let bottom = min(viewport.maxY, footer.frame.minY) - 8',
    'frame.minY >= viewport.minY + 8 && frame.maxY <= bottom',
    'frame.minX >= viewport.minX && frame.maxX <= viewport.maxX',
    'guard fullyVisible() else',
    'geometry.name = "permissions-microphone-target-geometry"',
    'attach(app, "permissions-microphone-before-request")',
    'XCTAssertTrue(microphone.label.hasPrefix("Allow"),',
    'XCTAssertTrue(alert.waitForExistence(timeout: 10))',
    'deny.tap()',
    'XCTAssertTrue(microphone.label.hasPrefix("Settings:"))',
    'XCTAssertEqual(toggle.value as? String, "0")',
    'NSPredicate(format: "value == %@", "1")',
    'let returnBudget: TimeInterval = 10',
    'let returnStarted = ProcessInfo.processInfo.systemUptime',
    'let toggleRemaining = max(0, returnBudget - (ProcessInfo.processInfo.systemUptime - returnStarted))',
    'guard XCTWaiter.wait(for: [enabled], timeout: toggleRemaining) == .completed else',
    'let exitRemaining = returnBudget - (ProcessInfo.processInfo.systemUptime - returnStarted)',
    'guard exitRemaining > 0 else',
    'guard app.wait(for: .notRunning, timeout: exitRemaining) else',
    'guard exitElapsed < returnBudget else',
    'let resumeState = app.state',
    'app.activate()',
    'let activationElapsed = ProcessInfo.processInfo.systemUptime - returnStarted',
    'let remaining = max(0, returnBudget - (ProcessInfo.processInfo.systemUptime - returnStarted))',
    'let result = XCTWaiter.wait(for: [restored], timeout: remaining)',
    'let allowedElapsed = ProcessInfo.processInfo.systemUptime - returnStarted',
    'XCTAssertEqual(result, .completed,',
    'XCTAssertLessThanOrEqual(allowedElapsed, returnBudget,',
    'NSPredicate(format: "exists == true AND label == %@", "Allowed")',
    'XCTAssertTrue(microphoneStatus.exists,',
    'XCTAssertEqual(microphoneStatus.label, "Allowed")',
    'returnPath=tcc-cold-activation; toggleAndExitSeconds=',
    'process.name = "permissions-settings-return-timing"',
    'hierarchy.name = "permissions-settings-return-accessibility"',
  ]) assert.ok(text.includes(required), required);
  assert.equal((text.match(/let returnStarted =/g) || []).length, 1);
  const positions = [
    'let returnStarted =', 'toggle.coordinate(', 'let enabled =',
    'app.wait(for: .notRunning, timeout: exitRemaining)', 'app.activate()',
    'let microphoneStatus =', 'let restored =', 'let remaining =',
    'let allowedElapsed =', 'XCTAssertLessThanOrEqual(allowedElapsed',
  ].map(needle => text.indexOf(needle));
  assert.ok(positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1])),
    'toggle, exit observation, activation, AX and predicate setup must be timed in order');
  const timed = text.slice(positions[0], positions.at(-1));
  assert.ok(!/attach\(|debugDescription|XCTAttachment|waitForExistence|app\.launch\(|resumeState\s*==/.test(timed),
    'no diagnostics, extra budgets or conditional relaunch in timed interval');
  assert.equal((text.match(/app\.activate\(\)/g) || []).length, 1);
  const returning = text.slice(text.indexOf('let returnStarted ='));
  assert.ok(!/app\.launch\(|resumeState\s*==|app\.terminate\(/.test(returning), 'same return action without forced process state');
  assert.ok(!/simctl|privacy grant|[.]setAuthorization/.test(text), 'no synthetic grants');
}

test('common native driver has one end-to-end ten-second monotonic budget', () => contract(source));

test('rejects missing denial, Settings change, TCC exit, Allowed or total timing assertions', () => {
  for (const needle of ['deny.tap()', 'XCTAssertEqual(toggle.value as? String, "0")',
    'NSPredicate(format: "value == %@", "1")', 'NSPredicate(format: "exists == true AND label == %@", "Allowed")',
    'guard app.wait(for: .notRunning, timeout: exitRemaining) else', 'guard exitElapsed < returnBudget else',
    'XCTAssertEqual(result, .completed,', 'XCTAssertLessThanOrEqual(allowedElapsed, returnBudget,',
    'let returnBudget: TimeInterval = 10']) {
    assert.throws(() => contract(source.replace(needle, '// removed')));
  }
});

test('rejects off-clock toggle, AX setup, extra budgets or conditional activation', () => {
  assert.throws(() => contract(source.replace('        app.activate()', '        attach(app, "late")\n        app.activate()')));
  for (const name of ['remaining', 'toggleRemaining', 'exitRemaining']) {
    assert.throws(() => contract(source.replace(`timeout: ${name}`, 'timeout: 10')));
  }
  const start = '        let returnStarted = ProcessInfo.processInfo.systemUptime\n';
  assert.throws(() => contract(source.replace(start, '').replace('        app.activate()', start + '        app.activate()')));
  assert.throws(() => contract(source.replace('        app.activate()', '        if resumeState == .notRunning { app.launch() } else { app.activate() }')));
  const row = '        let microphoneStatus = app.descendants(matching: .any)["permissions.status.microphone"].firstMatch\n';
  assert.throws(() => contract(row + source.replace(row, '')));
});

test('rejects a microphone target hidden by the pinned footer even when hittable', () => {
  for (const needle of ['guard reveal(target, in: app) else { return }',
    'guard reveal(microphone, in: app) else { return }',
    'let bottom = min(viewport.maxY, footer.frame.minY) - 8',
    'frame.minY >= viewport.minY + 8 && frame.maxY <= bottom',
    'guard fullyVisible() else', 'attach(app, "permissions-microphone-before-request")']) {
    assert.throws(() => contract(source.replace(needle, '// removed')));
  }
});

test('opt-in matched workflow retains common overlay, recording, strict runtime and no retries', () => {
  assert.ok(workflow.includes('"$IOS_TEST_FILE" == "apps/ios/UITests/PermissionReturnTimingTests.swift"'));
  assert.ok(workflow.includes('node .evidence-harness/scripts/ios-permission-return-fixture.mjs .'));
  assert.ok(workflow.includes('VIDEO_NAME=permission-return'));
  assert.ok(workflow.includes('recordVideo --codec=h264 "evidence/$VIDEO_NAME.mp4"'));
  assert.ok(workflow.includes('test -n "$RUNTIME" && test -n "$TYPE"'));
  assert.ok(!workflow.includes('-retry-tests-on-failure'));
});

test('common overlay changes only the DEBUG fixture route, never permission readers or values', () => {
  const patched = permissionReturnFixture(appModel, app);
  assert.equal(patched.appModel, appModel.replace(
    'if args.contains("-uiTestNotificationStep") { showNotificationStep = true }',
    'if args.contains("-uiTestNotificationStep") || PermissionReturnEvidenceRoute.active { showNotificationStep = true }'));
  assert.ok(patched.app.includes('if PermissionReturnEvidenceRoute.active { return true }'));
  assert.ok(patched.app.includes('#if DEBUG\n/// Only the disposable permission-return evidence simulator'));
  assert.ok(patched.app.includes('defaults.set(true, forKey: key)'));
  assert.ok(patched.app.includes('return defaults.bool(forKey: key)'));
  assert.ok(patched.app.includes('defaults.set(false, forKey: "appLock")'));
  assert.ok(patched.app.includes('defaults.set("light", forKey: "theme")'));
  assert.equal((patched.app.slice(app.length).match(/defaults\.set\(/g) || []).length, 3);
  assert.ok(!/authorizationStatus|AVCaptureDevice|grant|microphoneAllowed\s*=/.test(patched.app.slice(app.length)));
  assert.throws(() => permissionReturnFixture(patched.appModel, patched.app));
  assert.throws(() => permissionReturnFixture(appModel.replace('-uiTestNotificationStep', '-missing'), app));
  assert.throws(() => permissionReturnFixture(appModel, app + app));
});
