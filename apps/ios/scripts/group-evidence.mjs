// Evidence-only data injection into the real ChatsView, identical for both app revisions.
// Run in a disposable CI checkout, never against a user's installed app or data.
import fs from 'node:fs';
const file = 'apps/ios/App/Views/ChatsView.swift';
let source = fs.readFileSync(file, 'utf8');
function replace(before, after) {
  if (!source.includes(before)) throw new Error(`Missing fixture anchor: ${before}`);
  source = source.replace(before, after);
}
replace('private var listSummaries: [SessionSummary] {', `private var listSummaries: [SessionSummary] {
        if ProcessInfo.processInfo.arguments.contains("-uiTestGroupList") {
            return SessionSummary.visible(try! JSONValue.parse(#"[{"id":"work","title":"Build the app","workspaceId":"work","exchangeCount":1,"activeRun":{},"phase":"building","modelId":"opus","transcriptTokens":42000,"claudeCodeContext":{"modelId":"opus","used":42000,"window":200000},"updatedAt":1793923200000},{"id":"watch","title":"Watch the checks","workspaceId":"watch","activeWatchCount":1,"updatedAt":1793923200000},{"id":"done","title":"Finished task","workspaceId":"done","exchangeCount":1,"updatedAt":1793923200000}]"#))
        }
        return`);
replace('private var listActivity: [String: Activity] {', `private var listActivity: [String: Activity] {
        if ProcessInfo.processInfo.arguments.contains("-uiTestGroupList") { return ["work": .running] }
        return`);
replace('private var listFolders: [WorkspaceFolder] {', `private var listFolders: [WorkspaceFolder] {
        if ProcessInfo.processInfo.arguments.contains("-uiTestGroupList") { return [WorkspaceFolder(id: "work", name: "Working project"), WorkspaceFolder(id: "watch", name: "Watching project"), WorkspaceFolder(id: "done", name: "Finished project")] }
        return`);
// Keep the real persisted preference, so native toggle and relaunch tests exercise it.
replace('store.rowPrs[s.id] ?? []', '(ProcessInfo.processInfo.arguments.contains("-uiTestGroupList") ? PullRequest.list(try! JSONValue.parse(#"[{"url":"https://github.com/example/project/pull/42","number":42,"state":"open"}]"#)) : store.rowPrs[s.id] ?? [])');
// This is only a test selector, added to the original header on both revisions.
if (!source.includes('.accessibilityIdentifier("chats.group.')) {
  replace('.accessibilityHint("Double-tap to fold or unfold the group.")', '.accessibilityHint("Double-tap to fold or unfold the group.")\n        .accessibilityIdentifier("chats.group.\\(g.key)")');
}
// Give the pre-fix baseline the same nonvisual row selector as the fixed app.
// This changes no visibility, preference, or Card details interaction behavior.
if (!source.includes('.accessibilityIdentifier("chats.row.updated")')) {
  replace('.font(.caption2).foregroundStyle(palette.inkFaint).padding(.top, 3)', '.font(.caption2).foregroundStyle(palette.inkFaint).padding(.top, 3)\n                    .accessibilityIdentifier("chats.row.updated")');
}
fs.writeFileSync(file, source);
const root = 'apps/ios/App/NekkoApp.swift';
source = fs.readFileSync(root, 'utf8');
replace('if ProcessInfo.processInfo.arguments.contains("-uiTestPhotoPreviews") {', 'if ProcessInfo.processInfo.arguments.contains("-uiTestGroupList") {\n            NavigationStack { ChatsView(path: .constant([])) }\n        } else if ProcessInfo.processInfo.arguments.contains("-uiTestPhotoPreviews") {');
// Join the isolated routes regardless of which fixture currently comes first.
// This disables every transport/lifecycle side effect, not only app.start().
replace('let flags = [', 'let flags = ["-uiTestGroupList", ');
fs.writeFileSync(root, source);
const prefs = 'apps/ios/App/Platform/Prefs.swift';
source = fs.readFileSync(prefs, 'utf8');
// Start each isolated test clean, but leave the real stored value intact on relaunch.
replace('d = defaults', `d = defaults
        if ProcessInfo.processInfo.arguments.contains("-uiTestGroupList") && !ProcessInfo.processInfo.arguments.contains("-uiTestKeepGroups") {
            defaults.removeObject(forKey: "openedChatGroups")
        }`);
replace('chatListView = ChatListView.parse(d.data(forKey: "chatListView"))', 'chatListView = ProcessInfo.processInfo.arguments.contains("-uiTestGroupList") && !ProcessInfo.processInfo.arguments.contains("-uiTestKeepCardDetails") ? .standard : ChatListView.parse(d.data(forKey: "chatListView"))');
fs.writeFileSync(prefs, source);
const test = 'apps/ios/UITests/GroupEvidenceTests.swift';
if (process.argv.includes('--before')) {
  fs.writeFileSync(test, fs.readFileSync(test, 'utf8').replace('let after = true', 'let after = false').replace('let remembersGroups = true', 'let remembersGroups = false'));
}
