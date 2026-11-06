#!/usr/bin/env node
// Overlay only DEBUG fixture routing on the exact old app, never Notifier code.
// The old @main owns AppModel eagerly. Put its unchanged content behind a lazy
// View branch, then guard delegate hooks. Fail closed on changed base structure.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function overlay(input) {
  let source = input;
  function once(old, replacement) {
    assert.equal(source.split(old).length - 1, 1, `Expected one baseline anchor: ${old}`);
    source = source.replace(old, replacement);
  }
  once('@main\n@MainActor\nstruct NekkoApp: App {',
    '@MainActor\nprivate struct BaselineNativeAppContent: View {');
  once('    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate\n', '');
  once('    var body: some Scene {\n        WindowGroup {',
    '    var body: some View {\n        Group {');
  once('        OutboxRefresh.register()',
    '        guard !BaselineAttentionRoute.isolated else { return true }\n        OutboxRefresh.register()');
  once('        MainActor.assumeIsolated { AppModel.shared.didRegister(deviceToken: deviceToken) }',
    '        guard !BaselineAttentionRoute.isolated else { return }\n        MainActor.assumeIsolated { AppModel.shared.didRegister(deviceToken: deviceToken) }');
  once('        guard let tag = userInfo["dismiss"] as? String else { return .noData }',
    '        guard !BaselineAttentionRoute.isolated else { return .noData }\n        guard let tag = userInfo["dismiss"] as? String else { return .noData }');
  once('        guard let url = url(for: type) else { return false }',
    '        guard !BaselineAttentionRoute.isolated, let url = url(for: type) else { return false }');
  return source + `

// Evidence-only lazy route. No model, stores, defaults or transports.
private enum BaselineAttentionRoute {
    static var isolated: Bool {
        #if DEBUG
        return ProcessInfo.processInfo.arguments.contains("-uiTestSystemAttentionNotifications")
        #else
        return false
        #endif
    }
}

@main
@MainActor
struct NekkoApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    var body: some Scene {
        WindowGroup {
            #if DEBUG
            if BaselineAttentionRoute.isolated {
                SystemAttentionNotificationsFixture()
            } else { BaselineNativeAppContent() }
            #else
            BaselineNativeAppContent()
            #endif
        }
    }
}
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv[2];
  writeFileSync(path, overlay(readFileSync(path, 'utf8')));
}
