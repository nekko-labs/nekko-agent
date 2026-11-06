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
            return SessionSummary.visible(try! JSONValue.parse(#"[{"id":"work","title":"Build the app","workspaceId":"work","updatedAt":1793923200000},{"id":"watch","title":"Watch the checks","workspaceId":"watch","activeWatchCount":1,"updatedAt":1793923200000},{"id":"done","title":"Finished task","workspaceId":"done","updatedAt":1793923200000}]"#))
        }
        return`);
replace('private var listActivity: [String: Activity] {', `private var listActivity: [String: Activity] {
        if ProcessInfo.processInfo.arguments.contains("-uiTestGroupList") { return ["work": .running] }
        return`);
replace('private var listFolders: [WorkspaceFolder] {', `private var listFolders: [WorkspaceFolder] {
        if ProcessInfo.processInfo.arguments.contains("-uiTestGroupList") { return [WorkspaceFolder(id: "work", name: "Working project"), WorkspaceFolder(id: "watch", name: "Watching project"), WorkspaceFolder(id: "done", name: "Finished project")] }
        return`);
replace('private var view: ChatListView { app.prefs.chatListView }', 'private var view: ChatListView { ProcessInfo.processInfo.arguments.contains("-uiTestGroupList") ? .standard : app.prefs.chatListView }');
// This is only a test selector, added to the original header on both revisions.
if (!source.includes('.accessibilityIdentifier("chats.group.')) {
  replace('.accessibilityHint("Double-tap to fold or unfold the group.")', '.accessibilityHint("Double-tap to fold or unfold the group.")\n        .accessibilityIdentifier("chats.group.\\(g.key)")');
}
fs.writeFileSync(file, source);
const root = 'apps/ios/App/NekkoApp.swift';
source = fs.readFileSync(root, 'utf8');
replace('if ProcessInfo.processInfo.arguments.contains("-uiTestPhotoPreviews") {', 'if ProcessInfo.processInfo.arguments.contains("-uiTestGroupList") {\n            NavigationStack { ChatsView(path: .constant([])) }\n        } else if ProcessInfo.processInfo.arguments.contains("-uiTestPhotoPreviews") {');
replace('                    app.start()', '                    if ProcessInfo.processInfo.arguments.contains("-uiTestGroupList") { return }\n                    app.start()');
fs.writeFileSync(root, source);
const test = 'apps/ios/UITests/GroupEvidenceTests.swift';
if (process.argv.includes('--before')) {
  fs.writeFileSync(test, fs.readFileSync(test, 'utf8').replace('let after = true', 'let after = false'));
}
