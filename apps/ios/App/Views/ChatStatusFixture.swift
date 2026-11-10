#if DEBUG
import NekkoProtocol
import SwiftUI

/// Deterministic native visual/interaction fixture. No pairing or network calls.
struct ChatStatusFixture: View {
    @Environment(\.palette) private var palette
    @State private var path: [Route] = []
    @State private var feedback = false
    @State private var pull = PawPull()
    @State private var refreshHistory: [String] = []
    private var recordRefresh: Bool { ProcessInfo.processInfo.arguments.contains("-uiTestRefreshHistory") }
    var body: some View {
        NavigationStack {
            List {
                Section("General") {
                    fixtureRow(ProcessInfo.processInfo.arguments.contains("-uiTestLongTitles") ? "Fix automatic chat titles and make composer options compact" : "Working", activity: .running, model: "claude-opus-5-5", provider: "claude-code", tokens: 45_000,
                               prs: [Self.pr(41, .open, draft: true)])
                    fixtureRow("Needs attention", activity: .needsYou, model: "gpt-5", provider: "chatgpt", tokens: 268_000)
                    fixtureRow("Watching", activity: nil, activeWatchCount: 1, model: "claude-sonnet-5-5", tokens: 910_000,
                               prs: [Self.pr(42, .open), Self.pr(43, .merged), Self.pr(44, .closed)])
                    fixtureRow("Done without watches", activity: nil, model: "qwen3-coder:latest", provider: "ollama", tokens: 12_000,
                               prs: [Self.pr(40, .merged), Self.pr(39, .closed)])
                    fixtureRow("Done", activity: nil, archived: true)
                }
            }
            .listStyle(.plain)
            .appBackground()
            .pawRefreshable(pull) { try? await Task.sleep(for: .seconds(1.2)) }
            // XCTest may wait for the entire refresh before returning from a drag.
            // Keep the real state transitions observable without stretching their timing.
            .onChange(of: pull.shocked) { old, new in
                guard recordRefresh else { return }
                if new { refreshHistory.append("Refreshing") }
                else if old { refreshHistory.append("Working") }
            }
            .overlay(alignment: .bottom) {
                if recordRefresh {
                    Text(refreshHistory.isEmpty ? "No refresh yet" : refreshHistory.joined(separator: " → "))
                        .font(.caption2).foregroundStyle(palette.inkSoft)
                        .accessibilityIdentifier("seasonal.refreshHistory")
                        .allowsHitTesting(false)
                }
            }
            .navigationTitle("Chats")
            .toolbar {
                RootMascot(working: true, pull: pull)
                ToolbarItem(placement: .topBarLeading) { ComputerMenu(path: $path, feedback: $feedback) }
                ToolbarItem(placement: .topBarTrailing) { Image(systemName: "line.3.horizontal.decrease") }
                ToolbarItem(placement: .topBarTrailing) { Image(systemName: "square.and.pencil") }
            }
        }
    }

    private func fixtureRow(_ title: String, activity: Activity?, archived: Bool = false, activeWatchCount: Int = 0,
                            model: String? = nil, provider: String? = nil, tokens: Int = 0, prs: [PullRequest] = []) -> some View {
        // Decode the same narrow wire projection used by the production list.
        let modelField = model.map { "\"modelId\":\"\($0)\"," } ?? ""
        let data = Data("""
        {"id":"\(title)","title":"\(title)",\(modelField)"transcriptTokens":\(tokens),"activeWatchCount":\(activeWatchCount),"createdAt":0,"updatedAt":1792800000000,"archivedAt":\(archived ? "1792800000000" : "null"),"firstUserText":"A deterministic chat preview"}
        """.utf8)
        return Group {
            if let wire = try? JSONDecoder().decode(JSONValue.self, from: data), let summary = SessionSummary.from(wire) {
                ChatRow(summary: summary, activity: activity, prs: prs, providerKind: provider)
            }
        }
        .listRowBackground(Color.clear)
    }

    /// A PR as `pr:sessionList` sends one.
    static func pr(_ n: Int, _ state: PullRequest.State, draft: Bool = false) -> PullRequest {
        let wire: JSONValue = [["url": .string("https://github.com/o/r/pull/\(n)"), "number": .int(Int64(n)), "title": .string("PR \(n)"),
                                "state": .string(state.rawValue), "isDraft": .bool(draft)]]
        return PullRequest.list(wire)[0]
    }
}
#endif
