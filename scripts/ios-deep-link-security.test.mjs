import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = path => readFileSync(new URL(`../apps/ios/${path}`, import.meta.url), 'utf8');
const source = read('Tests/AppTests.swift');
const routing = source.match(/final class DeepLinkTests: XCTestCase \{([\s\S]*?)\n\}\n/)[1];
const establishesUnlockedPrecondition = body => {
  assert.match(body, /let savedAppLock = app.prefs.appLock\s+defer \{ app.prefs.appLock = savedAppLock \}\s+app.prefs.appLock = false/);
  assert.ok(body.indexOf('app.prefs.appLock = false') < body.indexOf('app.handle(url:'));
};

// Source contracts complement, but do not replace, the native XCTest execution.
test('deep-link routing establishes and restores its own unlocked preference', () => {
  establishesUnlockedPrecondition(routing);
  assert.doesNotMatch(routing, /app.lock\.(?:disable|unlock|didEnterBackground)\(/);
});

test('the contract rejects the old test which depended on singleton lock state', () => {
  const old = routing.replace(/        \/\/ Routing consumes[^\n]*\n        let savedAppLock[^\n]*\n        defer[^\n]*\n        app.prefs.appLock = false\n/, '');
  assert.notEqual(old, routing);
  assert.throws(() => establishesUnlockedPrecondition(old), assert.AssertionError);
});

test('production still refuses locked, wrong-chat and wrong-call requests before consuming them', () => {
  const body = read('App/AppModel.swift').match(/func takeAlwaysAllow\(_ chatId: String, callId: String\) -> Bool \{([\s\S]*?)\n    \}/)[1];
  assert.match(body, /guard let want = alwaysAllowIn, want.chatId == chatId, want.callId == callId, !\(prefs.appLock && lock.locked\) else \{ return false \}/);
  assert.ok(body.indexOf('return false') < body.indexOf('alwaysAllowIn = nil'));
  assert.match(body, /alwaysAllowIn = nil\s+return true/);
});

test('identity, one-shot and invalid-link assertions remain in the native routing test', () => {
  assert.match(routing, /XCTAssertFalse\(app.takeAlwaysAllow\("s_other", callId: "call_7"\), "another chat"\)/);
  assert.match(routing, /XCTAssertFalse\(app.takeAlwaysAllow\("s_123", callId: "call_8"\), "another call in the same chat"\)/);
  assert.match(routing, /XCTAssertTrue\(app.takeAlwaysAllow\("s_123", callId: "call_7"\)\)/);
  assert.match(routing, /XCTAssertFalse\(app.takeAlwaysAllow\("s_123", callId: "call_7"\), "taken once"\)/);
  assert.match(routing, /XCTAssertNil\(app.alwaysAllowIn, "an empty call id is no request"\)/);
});
