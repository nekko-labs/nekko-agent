// Source contracts only: native XCTest still has to compile and execute these checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const relay = fs.readFileSync(new URL('../UITests/LiveRelayTests.swift', import.meta.url), 'utf8');
const security = fs.readFileSync(new URL('../UITests/SecurityEvidenceTests.swift', import.meta.url), 'utf8');

function notificationContract(source) {
  const start = source.indexOf('let test = app.buttons["settings.notify.test"]');
  const end = source.indexOf('let bannerShot =', start);
  assert.ok(start >= 0 && end > start, 'the actual notification journey is present');
  const body = source.slice(start, end);
  assert.match(body, /let deadline = Date\(\)\.addingTimeInterval\(20\)/);
  assert.match(body, /XCTWaiter\.wait\(for: \[enabled\], timeout: busyWait\)/);
  assert.ok(body.indexOf('XCTWaiter.wait') < body.indexOf('test.tap()'));
  assert.match(body, /RunLoop\.current\.run\(until: Date\(\)\.addingTimeInterval\(0\.5\)\)/);
  assert.match(body, /XCTAssertTrue\(result\.exists, "the test reports which path it took"\)/);
  assert.match(body, /XCTAssertTrue\(result\.label\.contains\("shown by the app"\), result\.label\)/);
  assert.match(body, /XCTAssertTrue\(banner\.waitForExistence\(timeout: 10\)/);
}

function securityContract(source) {
  const start = source.indexOf('func testAlwaysAllowFromTheLockScreenOrANotificationEvidence()');
  const end = source.indexOf('private func attach', start);
  assert.ok(start >= 0 && end > start, 'the actual signed-action journey is present');
  const body = source.slice(start, end);
  assert.ok(body.includes('[(0, "Building"), (1, "Need input"), (0, "Done")]'));
  assert.ok(body.includes('card.descendants(matching: .any).matching(NSPredicate('));
  assert.ok(body.includes('label CONTAINS %@ AND label MATCHES %@'));
  assert.ok(body.includes('XCTAssertTrue(metric.exists'));
  assert.ok(body.includes('XCTAssertTrue(card.staticTexts["Open app"].exists'));
  assert.ok(body.includes('XCTAssertFalse(card.staticTexts["Always allow"].exists'));
  assert.ok(body.includes('XCTAssertFalse(card.buttons["approval.alwaysAllow"].exists'));
  assert.ok(body.includes('XCTAssertTrue(ran, "the link ran the card\'s own Always allow")'));
  assert.ok(body.includes('XCTAssertTrue(waiting.exists, "a refused save approves nothing: the call still waits")'));
}

test('the native notification journey keeps its original bounded result contract', () => {
  notificationContract(relay);
});

test('a longer deadline cannot silently replace the notification contract', () => {
  for (const budget of ['120', 'computerWait']) {
    assert.throws(() => notificationContract(relay.replace(
      'let deadline = Date().addingTimeInterval(20)',
      `let deadline = Date().addingTimeInterval(${budget})`)));
  }
});

test('online readiness, yielding poll, actual result and visible banner remain required', () => {
  for (const required of [
    'XCTWaiter.wait(for: [enabled], timeout: busyWait)',
    'RunLoop.current.run(until: Date().addingTimeInterval(0.5))',
    'XCTAssertTrue(result.exists, "the test reports which path it took")',
    'XCTAssertTrue(result.label.contains("shown by the app"), result.label)',
    'XCTAssertTrue(banner.waitForExistence(timeout: 10)',
  ]) {
    assert.ok(relay.includes(required), required);
    assert.throws(() => notificationContract(relay.replace(required, '// removed')));
  }
});

test('the dashboard evidence checks counts and handoff, not only container presence', () => {
  securityContract(security);
  for (const required of ['(1, "Need input")', 'XCTAssertTrue(metric.exists',
    'XCTAssertTrue(card.staticTexts["Open app"].exists']) {
    assert.throws(() => securityContract(security.replace(required, '// removed')));
  }
});

test('dashboard evidence retains signed-link execution and refused-save safety checks', () => {
  for (const required of [
    'XCTAssertTrue(ran, "the link ran the card\'s own Always allow")',
    'XCTAssertTrue(waiting.exists, "a refused save approves nothing: the call still waits")',
    'XCTAssertFalse(card.staticTexts["Always allow"].exists',
    'XCTAssertFalse(card.buttons["approval.alwaysAllow"].exists',
  ]) {
    assert.throws(() => securityContract(security.replace(required, '// removed')));
  }
});
