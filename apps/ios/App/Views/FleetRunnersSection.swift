import NekkoKit
import NekkoProtocol
import SwiftUI

/// The organizations' CI runners (decision 0064), read through this computer while it is the
/// connected one. Shows nothing until some computer in its organizations reports a runner.
/// ComputerDetailView runs `poll`: a List never builds an empty section, so its own task wouldn't run.
struct FleetRunnersSection: View {
    let computerId: String
    let computers: [FleetRunnerComputer]
    @Environment(ComputersStore.self) private var store
    @Environment(\.palette) private var palette

    var body: some View {
        if store.activeId == computerId, store.conn == .online, !computers.isEmpty {
            Section {
                ForEach(computers) { c in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(c.you ? "\(c.name) (this computer)" : c.name).font(.body)
                        if c.online {
                            ForEach(c.lines, id: \.self) { Text($0).font(.footnote).foregroundStyle(palette.inkSoft) }
                        } else {
                            Text("Offline").font(.footnote).foregroundStyle(palette.inkFaint)
                        }
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("fleetRunners.computer")
                }
            } header: {
                SectionTitle("CI runners")
            } footer: {
                Text("Macs your organizations share, as \(store.computers.first { $0.id == computerId }?.name ?? "this computer") sees them.")
                    .foregroundStyle(palette.inkSoft)
            }
        }
    }

    /// Reads the fleet every 30 seconds while `computerId` is the connected computer. An older
    /// computer, or one with no Cloud account, refuses the channel: the list stays as it was.
    @MainActor
    static func poll(_ store: ComputersStore, _ computerId: String, into update: ([FleetRunnerComputer]) -> Void) async {
        while !Task.isCancelled, store.activeId == computerId, store.conn == .online {
            if let raw = try? await store.call(read: Channels.fleetRunners, [], timeout: 15) { update(FleetRunnerComputer.list(raw)) }
            do { try await Task.sleep(nanoseconds: 30_000_000_000) } catch { return }
        }
    }
}
