import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Whether a relay address answers right now, without joining the room: what
/// `RelayClient` asks of the better route before moving back to it.
public protocol RouteProber: Sendable {
    func reachable(_ relayUrl: String, timeout: TimeInterval) async -> Bool
}

/// Asks the relay's `/healthz` over HTTP(S) at the same address
/// (`ws://h:p` → `http://h:p/healthz`). Nothing about the room, the device or
/// the computer is sent. Same ATS rules as the socket.
public struct HealthProber: RouteProber {
    public init() {}

    public static func healthURL(_ relayUrl: String) -> URL? {
        var s = relayUrl.trimmingCharacters(in: .whitespaces)
        while s.hasSuffix("/") { s.removeLast() }
        let lower = s.lowercased()
        if lower.hasPrefix("wss://") { s = "https://" + s.dropFirst(6) } else if lower.hasPrefix("ws://") { s = "http://" + s.dropFirst(5) } else { return nil }
        return URL(string: s + "/healthz")
    }

    public func reachable(_ relayUrl: String, timeout: TimeInterval) async -> Bool {
        guard let url = Self.healthURL(relayUrl) else { return false }
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = timeout
        config.timeoutIntervalForResource = timeout
        config.httpCookieStorage = nil
        config.urlCache = nil
        #if canImport(Darwin)
        config.waitsForConnectivity = false
        #endif
        let session = URLSession(configuration: config)
        defer { session.finishTasksAndInvalidate() }
        var req = URLRequest(url: url)
        req.timeoutInterval = timeout
        return await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
            session.dataTask(with: req) { _, response, error in
                cont.resume(returning: error == nil && (response as? HTTPURLResponse)?.statusCode == 200)
            }.resume()
        }
    }
}
