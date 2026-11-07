import Foundation

/// A presentation of the authenticated hosted fleet, not third-party cloud model providers.
public struct CloudFleet: Equatable, Sendable {
    public struct Row: Identifiable, Equatable, Sendable {
        public let machine: CloudSync.Machine
        /// A real saved pairing, never inferred from a name, room, platform or relay URL.
        public let computerId: String?
        public var id: String { machine.id }

        public var explanation: String? {
            guard ["running", "stopped", "starting", "created"].contains(machine.state) else {
                return "This machine's state is not supported on this iPhone. Manage it in Nekko Cloud."
            }
            return computerId == nil ? "Not paired with this iPhone. Pair this existing machine before opening it." : nil
        }
    }

    public let visible: Bool
    public let rows: [Row]
    /// Remove these from the ordinary paired list only while the group represents them.
    public var excludedComputerIds: Set<String> { Set(rows.compactMap(\.computerId)) }

    public init(enabled: Bool, signedIn: Bool, connected: Bool, machines: [CloudSync.Machine],
                machineLinks: [String: String], pairedComputerIds: Set<String>) {
        visible = enabled && signedIn && connected
        rows = visible ? machines.map { machine in
            let linked = machineLinks[machine.id].flatMap { pairedComputerIds.contains($0) ? $0 : nil }
            return Row(machine: machine, computerId: linked)
        } : []
    }
}

@MainActor
public extension CloudSync {
    /// Safe task identity: contains no credentials. A feature/account change restarts a view's fetch.
    var fleetRefreshKey: String { "\(fleetEnabled):\(signedIn):\(account?.id ?? "")" }

    func fleet(pairedComputerIds: Set<String>) -> CloudFleet {
        CloudFleet(enabled: fleetEnabled, signedIn: signedIn, connected: fleetConnected,
                   machines: machines, machineLinks: machineLinks, pairedComputerIds: pairedComputerIds)
    }

    func fleetExcludedComputerIds(pairedComputerIds: Set<String>) -> Set<String> {
        fleet(pairedComputerIds: pairedComputerIds).excludedComputerIds
    }
}
