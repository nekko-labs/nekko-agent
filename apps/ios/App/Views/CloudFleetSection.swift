import NekkoKit
import SwiftUI

/// Hosted computers stay absent until enabled and an authenticated fleet fetch succeeds.
/// This view belongs inside a List. It never signs in, provisions or pairs a machine.
struct CloudFleetSection: View {
    @Environment(CloudSync.self) private var cloud
    @Environment(ComputersStore.self) private var store
    @Environment(\.palette) private var palette
    @State private var expanded = false

    private var fleet: CloudFleet {
        cloud.fleet(pairedComputerIds: Set(store.computers.map(\.id)))
    }

    var body: some View {
        Group {
            if fleet.visible {
                Section {
                    DisclosureGroup(isExpanded: $expanded) {
                        if fleet.rows.isEmpty {
                            Text("No cloud computers available.").foregroundStyle(palette.inkSoft)
                        }
                        ForEach(fleet.rows) { row in
                            if let id = row.computerId, row.explanation == nil {
                                NavigationLink(value: Route.computer(id)) { MachineRow(machine: row.machine) }
                                if let computer = store.computers.first(where: { $0.id == id }) {
                                    ComputerConnectionToggle(computer: computer)
                                }
                            } else {
                                VStack(alignment: .leading, spacing: 4) {
                                    MachineRow(machine: row.machine)
                                    Text(row.explanation ?? "Not available on this iPhone.")
                                        .font(.footnote).foregroundStyle(palette.inkSoft)
                                }
                            }
                        }
                    } label: {
                        Label("Nekko Cloud", systemImage: "cloud")
                    }
                    .accessibilityIdentifier("computers.cloudFleet")
                }
            }
        }
        .task(id: cloud.fleetRefreshKey) {
            guard cloud.fleetEnabled, cloud.signedIn else { return }
            try? await cloud.loadMachines()
        }
    }
}
