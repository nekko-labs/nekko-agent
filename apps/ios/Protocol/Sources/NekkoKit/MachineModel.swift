import Foundation
import NekkoProtocol
import Observation

/// One round trip to the computer, measured by the phone.
public struct RoundTrip: Equatable, Sendable, Identifiable {
    public let at: Int64
    public let ms: Int
    public var id: Int64 { at }

    public init(at: Int64, ms: Int) {
        self.at = at
        self.ms = ms
    }
}

/// The ring of round trips a computer's page draws: the last `keep`, newest last.
public enum RoundTrips {
    public static let keep = 20

    public static func append(_ samples: [RoundTrip], _ sample: RoundTrip, keep: Int = keep) -> [RoundTrip] {
        var out = samples
        out.append(sample)
        if out.count > keep { out.removeFirst(out.count - keep) }
        return out
    }

    /// The route's quality in a word, from the latest sample: nil until one exists.
    public static func quality(_ ms: Int) -> String {
        switch ms {
        case ..<80: return "Fast"
        case ..<250: return "Good"
        case ..<800: return "Slow"
        default: return "Very slow"
        }
    }
}

/// What a computer's page shows (`ComputerDetailView`): the computer's own
/// summary (`machine:summary`), its models and providers, its usage today,
/// and the round trip the phone measures itself, so it works on any computer
/// version and on a cloud machine. Refreshes every 30 s while the page is open.
@MainActor
@Observable
public final class MachineModel {
    public let computerId: String
    public private(set) var summary: MachineSummary?
    public private(set) var models: [ModelInfo] = []
    public private(set) var providers: [PublicProvider] = []
    public private(set) var usage: UsageSummary?
    public private(set) var samples: [RoundTrip] = []
    public private(set) var loading = false
    /// Why the summary is missing: an old computer (`channel-denied`) or no connection.
    public private(set) var summaryError: String?
    public private(set) var loadedOnce = false

    private let store: ComputersStore
    private let now: () -> Int64
    private var loop: Task<Void, Never>?

    public init(computerId: String, store: ComputersStore, now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.computerId = computerId
        self.store = store
        self.now = now
    }

    /// Whether this page is the computer the phone is talking to now.
    public var isActive: Bool { store.activeId == computerId }

    public func start() {
        guard loop == nil else { return }
        loop = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(nanoseconds: 30_000_000_000)
            }
        }
    }

    public func stop() {
        loop?.cancel()
        loop = nil
    }

    /// One pass: the round trip first (the cheapest call), then the rest.
    public func refresh() async {
        guard isActive, store.conn == .online, let r = try? store.remote() else { return }
        loading = true
        defer { loading = false; loadedOnce = true }
        await measure(r)
        if let raw = try? await r.call(Channels.machineSummary) {
            summary = MachineSummary.from(raw)
            summaryError = summary == nil ? "This computer didn’t answer with its details." : nil
        } else {
            summaryError = summary == nil ? "This computer is too old to send its details. Update Nekko Agent there." : summaryError
        }
        if let raw = try? await r.call(Channels.providersList) { providers = PublicProvider.list(raw) }
        var all: [ModelInfo] = []
        for p in providers where p.enabled {
            if let list = try? await store.loadModels(p.id) { all += list }
        }
        models = all
        if let raw = try? await r.call(Channels.usageSummary) { usage = UsageSummary.from(raw) }
    }

    /// Time `app:info`, the lightest open channel, and keep the sample.
    public func measure(_ r: RemoteConnection) async {
        let t0 = DispatchTime.now().uptimeNanoseconds
        guard (try? await r.call(Channels.appInfo)) != nil else { return }
        let ms = Int((DispatchTime.now().uptimeNanoseconds - t0) / 1_000_000)
        samples = RoundTrips.append(samples, RoundTrip(at: now(), ms: ms))
    }

    public var latest: RoundTrip? { samples.last }

    /// The models the computer has loaded, by id, from its summary.
    public var loadedIds: Set<String> { Set(summary?.resident.map(\.id) ?? []) }

    /// Today's spend and tokens from the usage summary's daily rows.
    public var today: UsageSummary.Day? {
        let day = Self.dayKey(now())
        return usage?.days.first { $0.date == day }
    }

    static func dayKey(_ ms: Int64) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: Date(timeIntervalSince1970: Double(ms) / 1000))
    }
}
