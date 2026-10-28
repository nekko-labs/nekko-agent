#if DEBUG
import NekkoProtocol
import SwiftUI

/// Deterministic native visual/interaction fixture. No pairing or network calls.
struct ChatStatusFixture: View {
    @Environment(\.palette) private var palette
    @State private var path: [Route] = []
    @State private var feedback = false
    @StateObject private var pull = PawPull()
    var body: some View {
        NavigationStack {
            List {
                Section("General") {
                    fixtureRow("Working", activity: .running)
                    fixtureRow("Needs attention", activity: .needsYou)
                    fixtureRow("Idle", activity: nil, activeWatchCount: 1)
                    fixtureRow("Done without watches", activity: nil)
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

    private func fixtureRow(_ title: String, activity: Activity?, archived: Bool = false, activeWatchCount: Int = 0) -> some View {
        // Decode the same narrow wire projection used by the production list.
        let data = Data("""
        {"id":"\(title)","title":"\(title)","activeWatchCount":\(activeWatchCount),"createdAt":0,"updatedAt":1792800000000,"archivedAt":\(archived ? "1792800000000" : "null"),"firstUserText":"A deterministic chat preview"}
        """.utf8)
        return Group {
            if let wire = try? JSONDecoder().decode(JSONValue.self, from: data), let summary = SessionSummary.from(wire) {
                ChatRow(summary: summary, activity: activity)
            }
        }
        .listRowBackground(Color.clear)
    }
}
#endif
