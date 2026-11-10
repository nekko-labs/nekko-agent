// Source-only contracts; the corrected harness still needs actual native execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../UITests/PermissionChecklistUITests.swift', import.meta.url), 'utf8');
const start = source.indexOf('func testMicrophoneDenialAndSettingsRecovery()');
const end = source.indexOf('func testGrantChecksOffTheRowAndOpensTheNext()', start);
assert.ok(start >= 0 && end > start);
const body = source.slice(start, end);

function contract(text) {
  for (const required of [
    'let row = app.descendants(matching: .any)["permissions.row.microphone"].firstMatch',
    'let expandable = row.elementType == .button',
    'let target = expandable ? row : microphone',
    'if expandable { row.tap() }',
    'guard target.exists && target.isHittable else',
    'route.name = "permissions-microphone-request-path"',
    'XCTAssertTrue(microphone.label.hasPrefix("Allow"),',
    'XCTAssertTrue(alert.waitForExistence(timeout: 10))',
    'deny.tap()',
    'XCTAssertTrue(microphone.label.hasPrefix("Settings:"))',
    'XCTAssertEqual(toggle.value as? String, "0")',
    'NSPredicate(format: "value == %@", "1")',
    'if resumeState == .notRunning { app.launch() } else { app.activate() }',
    'process.name = "permissions-settings-process-state"',
    'hierarchy.name = "permissions-settings-return-accessibility"',
    'NSPredicate(format: "label == %@", "Allowed")',
    'wait(for: [restored], timeout: 10)',
  ]) assert.ok(text.includes(required), required);
  assert.ok(!text.includes('let row = app.buttons["permissions.row.microphone"]'));
}

test('classifies actual AX row capability without querying a nonexistent baseline Button', () => {
  contract(body);
});

test('rejects a harness that skips real denial, Settings switch or restored-Allowed safety checks', () => {
  for (const required of ['deny.tap()', 'XCTAssertEqual(toggle.value as? String, "0")',
    'NSPredicate(format: "value == %@", "1")', 'wait(for: [restored], timeout: 10)']) {
    assert.throws(() => contract(body.replace(required, '// removed')));
  }
});

test('keeps both actual request paths and process/accessibility evidence', () => {
  for (const required of ['let expandable = row.elementType == .button',
    'if expandable { row.tap() }', 'let target = expandable ? row : microphone',
    'process.name = "permissions-settings-process-state"',
    'hierarchy.name = "permissions-settings-return-accessibility"']) {
    assert.throws(() => contract(body.replace(required, '// removed')));
  }
});
