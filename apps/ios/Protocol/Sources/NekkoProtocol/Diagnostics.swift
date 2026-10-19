import Foundation
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

/// One step of a route check: whether it worked, how long it took, and what it found.
public struct ProbeStep: Equatable, Sendable {
    public var ok: Bool
    public var ms: Int?
    public var detail: String?

    public init(ok: Bool, ms: Int? = nil, detail: String? = nil) {
        self.ok = ok
        self.ms = ms
        self.detail = detail
    }
}

/// The checks for one relay address (TASKS.md IO-21): the name resolves, a TCP
/// connection opens, and the relay lets this phone say hello to the computer.
/// A step after a failed one is skipped (nil).
public struct RouteReport: Equatable, Sendable, Identifiable {
    public let url: String
    public var dns: ProbeStep?
    public var tcp: ProbeStep?
    public var hello: ProbeStep?
    public var id: String { url }
    public var kind: RelayRoute { RelayRoute.of(url) }
    public var host: String { Pairing.relayHost(url) }
    /// Every step ran and worked.
    public var ok: Bool { dns?.ok == true && tcp?.ok == true && hello?.ok == true }

    public init(url: String, dns: ProbeStep? = nil, tcp: ProbeStep? = nil, hello: ProbeStep? = nil) {
        self.url = url
        self.dns = dns
        self.tcp = tcp
        self.hello = hello
    }
}

/// The network calls the checks make; `PosixProbeNetwork` for real, fakes in tests.
public protocol ProbeNetwork: Sendable {
    /// The addresses `host` resolves to (numeric strings).
    func resolve(_ host: String, timeout: TimeInterval) async throws -> [String]
    /// Opens (and closes) a TCP connection to `address:port`.
    func connect(_ address: String, port: Int, timeout: TimeInterval) async throws
}

public enum Diagnostics {
    /// Check one route. `hello` joins the room on that address and reports
    /// what the relay and computer said (the store does it with a throwaway
    /// relay client); `clock` returns seconds, for timings.
    public static func check(_ url: String, network: ProbeNetwork, timeout: TimeInterval = 5,
                             clock: @escaping @Sendable () -> TimeInterval = { Date().timeIntervalSince1970 },
                             hello: @Sendable (String) async -> ProbeStep) async -> RouteReport {
        var report = RouteReport(url: url)
        guard let (host, port) = hostPort(url) else {
            report.dns = ProbeStep(ok: false, detail: "Not a relay address")
            return report
        }
        func ms(_ start: TimeInterval) -> Int { max(0, Int(((clock() - start) * 1000).rounded())) }

        var addresses = [host]
        if isLiteral(host) {
            report.dns = ProbeStep(ok: true, ms: 0, detail: "Address, no lookup needed")
        } else {
            let start = clock()
            do {
                let found = try await network.resolve(host, timeout: timeout)
                guard !found.isEmpty else { throw RelayError("No addresses") }
                addresses = found
                report.dns = ProbeStep(ok: true, ms: ms(start), detail: found.prefix(3).joined(separator: ", "))
            } catch {
                report.dns = ProbeStep(ok: false, ms: ms(start), detail: "Name not found: \(redact(error.localizedDescription))")
                return report
            }
        }

        // Every address the name has, in order, as the socket would (`localhost`
        // is often ::1 first while the relay listens on 127.0.0.1).
        let start = clock()
        var lastError: Error?
        for address in addresses.prefix(4) {
            do {
                try await network.connect(address, port: port, timeout: timeout)
                let via = addresses.count > 1 ? " on \(address)" : ""
                report.tcp = ProbeStep(ok: true, ms: ms(start), detail: "Port \(port) open\(via)")
                lastError = nil
                break
            } catch {
                lastError = error
            }
        }
        if let lastError {
            report.tcp = ProbeStep(ok: false, ms: ms(start), detail: redact(lastError.localizedDescription))
            return report
        }

        report.hello = await hello(url)
        return report
    }

    /// Host and port of a ws/wss address (80 and 443 by default).
    public static func hostPort(_ url: String) -> (String, Int)? {
        let lower = url.trimmingCharacters(in: .whitespaces).lowercased()
        let secure: Bool
        if lower.hasPrefix("wss://") { secure = true } else if lower.hasPrefix("ws://") { secure = false } else { return nil }
        let host = RelayRoute.host(url)
        guard !host.isEmpty else { return nil }
        var authority = Pairing.relayHost(url)
        if let q = authority.firstIndex(where: { $0 == "?" || $0 == "#" }) { authority = String(authority[..<q]) }
        var port = secure ? 443 : 80
        if let close = authority.lastIndex(of: "]") { authority = String(authority[authority.index(after: close)...]) }
        if let colon = authority.lastIndex(of: ":"), let p = Int(authority[authority.index(after: colon)...]), (1...65535).contains(p) {
            port = p
        }
        return (host, port)
    }

    static func isLiteral(_ host: String) -> Bool {
        RelayRoute.ipv4(host) != nil || host.contains(":")
    }

    /// Strip anything that could get someone into the room, in case a
    /// transport error quotes the URL it dialed: `room`, `key`, `pair` and
    /// `code` values, and long hex runs.
    public static func redact(_ text: String) -> String {
        var out = text
        for name in ["room", "key", "pair", "code"] {
            out = out.replacingOccurrences(of: "\(name)=[^&\\s\"')]*", with: "\(name)=…", options: [.regularExpression, .caseInsensitive])
        }
        return out.replacingOccurrences(of: "[0-9a-fA-F]{16,}", with: "…", options: .regularExpression)
    }

    /// What *Share diagnostics* sends: the phone, the routes and how each
    /// check went, then the connection log. Hosts and timings only; never
    /// rooms, keys, codes or anything a chat said.
    public static func text(app: String, network: NetworkPath, routeInUse: String?, reports: [RouteReport],
                            log: String, at: Date = Date()) -> String {
        var lines = ["Nekko Agent connection diagnostics", "When: \(ISO8601DateFormatter().string(from: at))", "App: \(app)",
                     "Network: \(network.rawValue)"]
        if let r = routeInUse { lines.append("Route in use: \(Pairing.relayHost(r)) (\(RelayRoute.of(r)))") }
        lines.append("")
        if reports.isEmpty { lines.append("Checks: not run") }
        for r in reports {
            lines.append("Route \(r.host) (\(r.kind)): \(r.ok ? "ok" : "problem")")
            for (name, step) in [("dns", r.dns), ("tcp", r.tcp), ("hello", r.hello)] {
                guard let step else { lines.append("  \(name): skipped"); continue }
                var line = "  \(name): \(step.ok ? "ok" : "failed")"
                if let ms = step.ms { line += " \(ms) ms" }
                if let d = step.detail { line += " – \(d)" }
                lines.append(line)
            }
        }
        lines.append("")
        lines.append(log)
        return redact(lines.joined(separator: "\n"))
    }
}

/// DNS with `getaddrinfo` and a TCP connect with a non-blocking socket, on a
/// background queue with a deadline. The same code runs on iOS and in the
/// Linux tests.
public struct PosixProbeNetwork: ProbeNetwork {
    public init() {}

    public func resolve(_ host: String, timeout: TimeInterval) async throws -> [String] {
        try await Self.withDeadline(timeout, "Lookup timed out") { try Self.lookup(host, numeric: false) }
    }

    public func connect(_ address: String, port: Int, timeout: TimeInterval) async throws {
        try await Self.withDeadline(timeout + 1, "Connect timed out") { try Self.tcpConnect(address, port: port, timeout: timeout) }
    }

    /// Runs blocking `body` off the cooperative pool; gives up (leaving it to finish) after `seconds`.
    static func withDeadline<T: Sendable>(_ seconds: TimeInterval, _ message: String,
                                          _ body: @escaping @Sendable () throws -> T) async throws -> T {
        let once = Once<Result<T, Error>>()
        return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<T, Error>) in
            once.onSet = { cont.resume(with: $0) }
            DispatchQueue.global().async { once.set(Result { try body() }) }
            DispatchQueue.global().asyncAfter(deadline: .now() + seconds) { once.set(.failure(RelayError(message))) }
        }
    }

    static func lookup(_ host: String, numeric: Bool) throws -> [String] {
        var hints = addrinfo()
        hints.ai_family = AF_UNSPEC
        #if canImport(Glibc)
        hints.ai_socktype = Int32(SOCK_STREAM.rawValue)
        #else
        hints.ai_socktype = SOCK_STREAM
        #endif
        if numeric { hints.ai_flags = AI_NUMERICHOST }
        var res: UnsafeMutablePointer<addrinfo>?
        let rc = getaddrinfo(host, nil, &hints, &res)
        guard rc == 0, let first = res else { throw RelayError(String(cString: gai_strerror(rc))) }
        defer { freeaddrinfo(first) }
        var out: [String] = []
        var p: UnsafeMutablePointer<addrinfo>? = first
        while let ai = p {
            var buf = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            if getnameinfo(ai.pointee.ai_addr, ai.pointee.ai_addrlen, &buf, socklen_t(buf.count), nil, 0, NI_NUMERICHOST) == 0 {
                let s = String(cString: buf)
                if !out.contains(s) { out.append(s) }
            }
            p = ai.pointee.ai_next
        }
        return out
    }

    static func tcpConnect(_ address: String, port: Int, timeout: TimeInterval) throws {
        var hints = addrinfo()
        hints.ai_family = AF_UNSPEC
        hints.ai_flags = AI_NUMERICHOST | AI_NUMERICSERV
        #if canImport(Glibc)
        hints.ai_socktype = Int32(SOCK_STREAM.rawValue)
        #else
        hints.ai_socktype = SOCK_STREAM
        #endif
        var res: UnsafeMutablePointer<addrinfo>?
        let rc = getaddrinfo(address, String(port), &hints, &res)
        guard rc == 0, let ai = res else { throw RelayError(String(cString: gai_strerror(rc))) }
        defer { freeaddrinfo(ai) }
        let fd = socket(ai.pointee.ai_family, ai.pointee.ai_socktype, ai.pointee.ai_protocol)
        guard fd >= 0 else { throw RelayError(String(cString: strerror(errno))) }
        defer { close(fd) }
        _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL, 0) | O_NONBLOCK)
        if Darwin_or_Glibc_connect(fd, ai.pointee.ai_addr, ai.pointee.ai_addrlen) == 0 { return }
        guard errno == EINPROGRESS else { throw RelayError(String(cString: strerror(errno))) }
        var pfd = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
        let ready = poll(&pfd, 1, Int32(max(1, timeout * 1000)))
        guard ready > 0 else { throw RelayError(ready == 0 ? "No answer in \(Int(timeout)) s" : String(cString: strerror(errno))) }
        var err: Int32 = 0
        var len = socklen_t(MemoryLayout<Int32>.size)
        getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &len)
        guard err == 0 else { throw RelayError(String(cString: strerror(err))) }
    }
}

/// `connect(2)`, named so it doesn't collide with `PosixProbeNetwork.connect`.
private func Darwin_or_Glibc_connect(_ fd: Int32, _ addr: UnsafeMutablePointer<sockaddr>?, _ len: socklen_t) -> Int32 {
    #if canImport(Darwin)
    return Darwin.connect(fd, addr, len)
    #else
    return Glibc.connect(fd, addr, len)
    #endif
}

/// The first value wins; later ones are dropped.
private final class Once<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    var onSet: ((T) -> Void)?

    func set(_ value: T) {
        lock.lock()
        if done { lock.unlock(); return }
        done = true
        let f = onSet
        lock.unlock()
        f?(value)
    }
}
