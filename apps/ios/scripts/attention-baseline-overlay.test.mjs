import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { overlay } from './attention-baseline-overlay.mjs';

const baseline = 'e2e18a78bc281674b0cf0a5983589a21a5618121';
const source = execFileSync('git', ['show', `${baseline}:apps/ios/App/NekkoApp.swift`], { encoding: 'utf8' });

test('exact-base overlay makes the system fixture lazy and leaves one app entrypoint', () => {
  const patched = overlay(source);
  assert.equal((patched.match(/@main\b/g) ?? []).length, 1);
  assert.match(patched, /private struct BaselineNativeAppContent: View/);
  const entrypoint = patched.slice(patched.lastIndexOf('@main'));
  assert.match(entrypoint, /if BaselineAttentionRoute.isolated \{\s+SystemAttentionNotificationsFixture\(\)/);
  assert.doesNotMatch(entrypoint, /AppModel|UserDefaults|\.store|app\.start/);
  assert.match(patched, /guard !BaselineAttentionRoute.isolated else \{ return true \}\s+OutboxRefresh.register/);
  assert.match(patched, /guard !BaselineAttentionRoute.isolated else \{ return \}\s+MainActor.assumeIsolated/);
  // There must be no implementation of the feature in the baseline overlay.
  assert.doesNotMatch(patched, /setBadgeCount|reconcileBadge|badgeCount =|class Notifier/);
});

test('overlay fails closed on missing, duplicate or already-patched entrypoint', () => {
  assert.throws(() => overlay(source.replace('struct NekkoApp: App', 'struct Renamed: App')));
  assert.throws(() => overlay(source + '\n        OutboxRefresh.register()'));
  assert.throws(() => overlay(overlay(source)));
});

test('after route and fixture retain strict debug and store isolation', () => {
  const app = readFileSync(new URL('../App/NekkoApp.swift', import.meta.url), 'utf8');
  const fixture = readFileSync(new URL('../App/Views/SystemAttentionNotificationsFixture.swift', import.meta.url), 'utf8');
  assert.match(app, /#if DEBUG\s+if ProcessInfo.processInfo.arguments.contains\("-uiTestSystemAttentionNotifications"\)/);
  assert.match(app, /"-uiTestAttentionNotifications", "-uiTestSystemAttentionNotifications"\]/);
  assert.match(fixture, /^#if DEBUG/);
  assert.match(fixture, /let notifier = Notifier\(\)/);
  assert.match(fixture, /#if !NEKKO_ATTENTION_BASELINE\s+notifier.badgeCount/);
  assert.doesNotMatch(fixture, /AppModel\.shared|UserDefaults|ComputersStore\(|UNNotificationRequest\(/);
});
