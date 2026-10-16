import Foundation
import Network

/// Calls `onChange` when the phone moves to another network (Wi-Fi to cellular,
/// a VPN such as Tailscale coming up or going down), so the relay socket bound
/// to the old path is replaced at once instead of at the next failed ping.
/// Mirrors Android's `NetworkChanges`: the first path is the baseline, and an
/// unsatisfied path is ignored (the client's backoff handles "no network").
final class NetworkWatcher: @unchecked Sendable {
    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "nekko.network")
    private var last: String?
    var onChange: (@Sendable () -> Void)?

    func start() {
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self, path.status == .satisfied else { return }
            let key = path.availableInterfaces.map { "\($0.name):\($0.type)" }.sorted().joined(separator: ",")
            defer { self.last = key }
            if let last = self.last, last != key { self.onChange?() }
        }
        monitor.start(queue: queue)
    }

    func stop() { monitor.cancel() }
}
