import Foundation
import Network
import NekkoProtocol

/// Calls `onChange` when the phone moves to another network (Wi-Fi to cellular,
/// a VPN such as Tailscale coming up or going down), so the relay socket bound
/// to the old path is replaced at once instead of at the next failed ping.
/// Mirrors Android's `NetworkChanges`: the first path is the baseline, and an
/// unsatisfied path is ignored (the client's backoff handles "no network").
/// It also says what kind of network it is, so a computer's LAN route is only
/// tried on Wi-Fi or Ethernet (TASKS.md IO-20).
final class NetworkWatcher: @unchecked Sendable {
    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "nekko.network")
    private var last: String?
    var onChange: (@Sendable (NetworkPath) -> Void)?
    /// The first path, which isn't a change but tells the client where it is.
    var onFirst: (@Sendable (NetworkPath) -> Void)?

    func start() {
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self, path.status == .satisfied else { return }
            let key = path.availableInterfaces.map { "\($0.name):\($0.type)" }.sorted().joined(separator: ",")
            let kind = Self.kind(path)
            defer { self.last = key }
            if let last = self.last {
                if last != key { self.onChange?(kind) }
            } else {
                self.onFirst?(kind)
            }
        }
        monitor.start(queue: queue)
    }

    func stop() { monitor.cancel() }

    /// Wi-Fi or Ethernet: the LAN may be the computer's. Cellular alone: it isn't.
    static func kind(_ path: NWPath) -> NetworkPath {
        if path.usesInterfaceType(.wifi) || path.usesInterfaceType(.wiredEthernet) { return .local }
        if path.usesInterfaceType(.cellular) { return .cellular }
        // Behind a VPN (Tailscale) the path reports `other`; look at what's underneath.
        let types = Set(path.availableInterfaces.map(\.type))
        if types.contains(.wifi) || types.contains(.wiredEthernet) { return .local }
        if types.contains(.cellular) { return .cellular }
        return .unknown
    }
}
