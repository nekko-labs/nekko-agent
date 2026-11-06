#if DEBUG
import NekkoProtocol
import SwiftUI

/// Deterministic native visual/interaction fixture. No pairing or network calls.
struct ChatStatusFixture: View {
    @Environment(\.palette) private var palette
    @State private var path: [Route] = []
    @State private var feedback = false
    @State private var pull = PawPull()
    var body: some View {
        NavigationStack {
            List {
                Section("General") {
                    fixtureRow("Working", activity: .running, prs: [Self.pr(41, .open, draft: true)])
                    fixtureRow("Needs attention", activity: .needsYou)
                    fixtureRow("Watching", activity: nil, activeWatchCount: 1, prs: [Self.pr(42, .open)])
                    fixtureRow("Done without watches", activity: nil, prs: [Self.pr(40, .merged), Self.pr(39, .closed)])
                    fixtureRow("Done", activity: nil, archived: true)
                }
            }
            .listStyle(.plain)
            .appBackground()
            .pawRefreshable(pull) { try? await Task.sleep(for: .seconds(1.2)) }
            .navigationTitle("Chats")
            .toolbar {
                RootMascot(working: true, pull: pull)
                ToolbarItem(placement: .topBarLeading) { ComputerMenu(path: $path, feedback: $feedback) }
                ToolbarItem(placement: .topBarTrailing) { Image(systemName: "line.3.horizontal.decrease") }
                ToolbarItem(placement: .topBarTrailing) { Image(systemName: "square.and.pencil") }
            }
        }
    }

    private func fixtureRow(_ title: String, activity: Activity?, archived: Bool = false, activeWatchCount: Int = 0, prs: [PullRequest] = []) -> some View {
        // Decode the same narrow wire projection used by the production list.
        let data = Data("""
        {"id":"\(title)","title":"\(title)","activeWatchCount":\(activeWatchCount),"createdAt":0,"updatedAt":1792800000000,"archivedAt":\(archived ? "1792800000000" : "null"),"firstUserText":"A deterministic chat preview"}
        """.utf8)
        return Group {
            if let wire = try? JSONDecoder().decode(JSONValue.self, from: data), let summary = SessionSummary.from(wire) {
                ChatRow(summary: summary, activity: activity, prs: prs)
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
