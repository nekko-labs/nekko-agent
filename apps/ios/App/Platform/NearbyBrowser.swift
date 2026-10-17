import Foundation
import Network
import NekkoProtocol
import Observation

/// Looks for computers advertising `_nekko-agent._tcp` on this Wi-Fi (the
/// desktop's *Visible on this network*). Starts only when the user taps
/// **Look on this network**, because the first look shows iOS's local network
/// prompt, and stops by itself after [lookFor] so the phone isn't left
/// browsing. Finding a computer never pairs: the record has no secrets.
@MainActor @Observable
final class NearbyBrowser {
    enum State: Equatable {
        case idle
        case looking
        /// Local network access is off for this app (Settings → Nekko Agent).
        case denied
        case failed(String)
    }

    private(set) var found: [NearbyComputer] = []
    private(set) var state: State = .idle
    /// Set once a look has finished, so "none found" can be said.
    private(set) var looked = false
    private var browser: NWBrowser?
    private var timeout: Task<Void, Never>?
    let lookFor: Duration

    init(lookFor: Duration = .seconds(30)) {
        self.lookFor = lookFor
    }

    func start() {
        stop()
        found = []
        state = .looking
        let params = NWParameters()
        params.includePeerToPeer = false
        let b = NWBrowser(for: .bonjourWithTXTRecord(type: NearbyComputer.serviceType, domain: "local."), using: params)
        b.stateUpdateHandler = { [weak self] s in
            Task { @MainActor in self?.update(s) }
        }
        b.browseResultsChangedHandler = { [weak self] results, _ in
            let list = NearbyComputer.sorted(results.compactMap(Self.computer))
            Task { @MainActor in self?.found = list }
        }
        browser = b
        b.start(queue: .main)
        timeout = Task { [weak self, lookFor] in
            try? await Task.sleep(for: lookFor)
            guard !Task.isCancelled else { return }
            self?.finish()
        }
    }

    /// Leaving the screen: stop, forget what was found.
    func stop() {
        timeout?.cancel()
        timeout = nil
        browser?.cancel()
        browser = nil
        if state == .looking { state = .idle }
    }

    /// The look ran its time: stop, keep what was found on screen.
    private func finish() {
        stop()
        looked = true
    }

    private func update(_ s: NWBrowser.State) {
        switch s {
        case .waiting(let error), .failed(let error):
            if Self.isPolicyDenied(error) {
                stop()
                state = .denied
            } else if case .failed = s {
                stop()
                state = .failed(error.localizedDescription)
            }
        default:
            break
        }
    }

    /// `kDNSServiceErr_PolicyDenied`: the user said no to local network access.
    nonisolated static func isPolicyDenied(_ error: NWError) -> Bool {
        if case .dns(let code) = error { return code == -65570 }
        return false
    }

    nonisolated static func computer(_ r: NWBrowser.Result) -> NearbyComputer? {
        guard case let .service(name, _, _, _) = r.endpoint else { return nil }
        var txt: [String: String] = [:]
        if case let .bonjour(record) = r.metadata { txt = record.dictionary }
        return NearbyComputer.from(instance: name, txt: txt)
    }
}
