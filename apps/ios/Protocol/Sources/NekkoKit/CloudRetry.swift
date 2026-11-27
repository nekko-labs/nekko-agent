import Foundation

/// When Nekko Cloud calls are tried again, the same rules as the computer (`crates/nekko-cloud/src/http.rs`):
/// a failed connect is tried twice more, 0.5 s and 2 s later; a busy answer (502, 503, 504, or a 500 coded
/// `database-unavailable`) at most twice, after at least 5 s and then 10 s or the
/// longer `Retry-After` the API sent, plus up to 50% random extra; a 504 on sync push or pull never, because the
/// first request may still be running.
public struct CloudRetry: Sendable {
    /// What a retried call waited for.
    public enum Stall: Equatable, Sendable {
        case connect
        case busy
        case gatewayTimeout
    }

    public var connectWaits: [Duration] = [.milliseconds(500), .seconds(2)]
    /// The least to wait before each retry of a busy answer.
    public var busyFloors: [Duration] = [.seconds(5), .seconds(10)]
    /// The longest `Retry-After` honoured.
    public var retryAfterCap: Duration = .seconds(60)
    /// The most added on top of a wait, as a fraction (0.5 is up to 50% more).
    public var jitter = 0.5
    /// A random number in `[0, 1)`.
    public var unit: @Sendable () -> Double = { Double.random(in: 0..<1) }
    public var sleep: @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }

    public init() {}

    /// No real waiting, for tests that don't look at the schedule.
    public static var instant: CloudRetry {
        var r = CloudRetry()
        r.sleep = { _ in }
        return r
    }

    /// What kind of failure this is, if it is one worth another try.
    static func stall(status: Int?, code: String = "", error: Error? = nil) -> Stall? {
        if let status {
            if status == 502 || status == 503 { return .busy }
            if status == 504 { return .gatewayTimeout }
            // An API from before #3186 answered a database connect timeout with a bare 500.
            if status == 500 && code == "database-unavailable" { return .busy }
            return nil
        }
        guard let e = error as? URLError else { return nil }
        return e.code == .cannotConnectToHost || e.code == .cannotFindHost ? .connect : nil
    }

    /// A 504 on these is never retried; the next sync pass picks the work up again.
    static func isSyncTransfer(_ path: String) -> Bool {
        path.hasPrefix("/v1/sync/push") || path.hasPrefix("/v1/sync/pull")
    }

    /// The wait before the next retry, or nil when the failure should surface now.
    func wait(for stall: Stall, path: String, connectTries: Int, busyTries: Int, retryAfter: Duration?) -> Duration? {
        let base: Duration
        switch stall {
        case .connect:
            guard connectTries < connectWaits.count else { return nil }
            base = connectWaits[connectTries]
        case .gatewayTimeout where Self.isSyncTransfer(path):
            return nil
        case .busy, .gatewayTimeout:
            guard busyTries < busyFloors.count else { return nil }
            let floor = busyFloors[busyTries]
            base = retryAfter.map { max(min($0, retryAfterCap), floor) } ?? floor
        }
        return base * (1 + jitter * min(max(unit(), 0), 0.999_999))
    }

    /// `Retry-After` in whole seconds; a date or junk is ignored (the floor still applies).
    static func retryAfter(_ headers: [String: String]) -> Duration? {
        guard let v = headers.first(where: { $0.key.lowercased() == "retry-after" })?.value,
              let s = Int(v.trimmingCharacters(in: .whitespaces)), s >= 0 else { return nil }
        return .seconds(s)
    }
}
