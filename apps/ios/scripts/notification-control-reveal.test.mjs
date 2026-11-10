// Driver source contracts only; actual XCTest geometry and taps need native execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../UITests/LiveRelayTests.swift', import.meta.url), 'utf8');

function driverContract(text) {
  for (const control of ['finished', 'test']) {
    assert.ok(text.includes(`guard revealNotificationControl(${control}, in: app) else {`));
  }
  const start = text.indexOf('private func revealNotificationControl(');
  const end = text.indexOf('private func settle()', start);
  assert.ok(start >= 0 && end > start);
  const helper = text.slice(start, end);
  for (const required of [
    'guard element.exists else { return false }',
    'navigation.frame.maxY',
    '!frame.isEmpty && viewport.contains(frame) && element.isHittable',
    'let frame = element.frame\n                    settle()',
    'if insideContent(), element.frame == frame { return true }',
    'for upward in [true, false]',
    'for _ in 0..<8',
    'dy: 0.55',
    'element.frame.minY < top + 8 ? 120 : -120',
    'start.press(forDuration: 0.05, thenDragTo:',
  ]) assert.ok(helper.includes(required), required);
  assert.doesNotMatch(helper, /UserDefaults|launchArguments|setValue|\.tap\(/);
  assert.match(text, /XCTAssertEqual\(finished\.value as\? String, "1"\)/);
  assert.match(text, /\(knob\.exists \? knob : finished\)\.tap\(\)/);
  assert.match(text, /XCTAssertTrue\(waitValue\(finished, "0", 5\)/);
}

test('notification controls require the whole row below navigation and a settled frame', () => {
  driverContract(source);
});

test('hittability alone or removing either guarded call fails the driver contract', () => {
  for (const required of [
    'viewport.contains(frame)',
    'element.frame == frame',
    'guard revealNotificationControl(finished, in: app) else {',
    'guard revealNotificationControl(test, in: app) else {',
  ]) assert.throws(() => driverContract(source.replace(required, '// removed')));
});

test('switch state and five-second transition assertions cannot be removed', () => {
  for (const required of [
    'XCTAssertEqual(finished.value as? String, "1")',
    'XCTAssertTrue(waitValue(finished, "0", 5)',
  ]) assert.throws(() => driverContract(source.replace(required, '// removed')));
});
