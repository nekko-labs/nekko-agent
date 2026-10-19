import Foundation
import XCTest
@testable import NekkoProtocol
#if canImport(Glibc)
import Glibc
#elseif canImport(Darwin)
import Darwin
#endif

/// TASKS.md IO-21: the Connection screen's checks and *Share diagnostics*.
final class DiagnosticsTests: XCTestCase {
    struct FakeNetwork: ProbeNetwork {
        var addresses: [String: [String]] = [:]
        var open: Set<String> = []
        func resolve(_ host: String, timeout: TimeInterval) async throws -> [String] {
            guard let a = addresses[host] else { throw RelayError("unknown host") }
            return a
        }
        func connect(_ address: String, port: Int, timeout: TimeInterval) async throws {
            guard open.contains("\(address):\(port)") else { throw RelayError("Connection refused") }
        }
    }

    /// A clock that moves 12 ms per read.
    final class Ticks: @unchecked Sendable {
        var t: TimeInterval = 0
        func next() -> TimeInterval { t += 0.012; return t }
    }

    func testEveryStepWithTimingsWhenTheRouteWorks() async {
        let net = FakeNetwork(addresses: ["studio.tail1234.ts.net": ["100.101.102.103"]], open: ["100.101.102.103:4400"])
        let ticks = Ticks()
        let r = await Diagnostics.check("ws://studio.tail1234.ts.net:4400", network: net, clock: { ticks.next() }) { url in
            XCTAssertEqual(url, "ws://studio.tail1234.ts.net:4400")
            return ProbeStep(ok: true, ms: 40, detail: "Your computer answered")
        }
        XCTAssertEqual(r.dns, ProbeStep(ok: true, ms: 12, detail: "100.101.102.103"))
        XCTAssertEqual(r.tcp, ProbeStep(ok: true, ms: 12, detail: "Port 4400 open"))
        XCTAssertEqual(r.hello?.ok, true)
        XCTAssertTrue(r.ok)
        XCTAssertEqual(r.kind, .tailscale)
    }

    func testStopsAtTheFirstFailedStep() async {
        let net = FakeNetwork(addresses: ["studio.tail1234.ts.net": ["100.101.102.103"]])
        let noName = await Diagnostics.check("ws://nowhere.tail1234.ts.net:4400", network: net) { _ in
            XCTFail("no hello after a failed lookup")
            return ProbeStep(ok: true)
        }
        XCTAssertEqual(noName.dns?.ok, false)
        XCTAssertNil(noName.tcp)
        XCTAssertNil(noName.hello)

        let closed = await Diagnostics.check("ws://192.168.1.20:4400", network: net) { _ in
            XCTFail("no hello after a failed connect")
            return ProbeStep(ok: true)
        }
        XCTAssertEqual(closed.dns, ProbeStep(ok: true, ms: 0, detail: "Address, no lookup needed"))
        XCTAssertEqual(closed.tcp?.ok, false)
        XCTAssertEqual(closed.tcp?.detail, "Connection refused")
        XCTAssertNil(closed.hello)
        XCTAssertFalse(closed.ok)
    }

    func testReadsHostAndPort() {
        XCTAssertTrue(Diagnostics.hostPort("ws://192.168.1.20:4400").map { $0 == ("192.168.1.20", 4400) } ?? false)
        XCTAssertTrue(Diagnostics.hostPort("wss://relay.example.com").map { $0 == ("relay.example.com", 443) } ?? false)
        XCTAssertTrue(Diagnostics.hostPort("ws://studio.local/").map { $0 == ("studio.local", 80) } ?? false)
        XCTAssertTrue(Diagnostics.hostPort("ws://[fd7a:115c:a1e0::5]:4400").map { $0 == ("fd7a:115c:a1e0::5", 4400) } ?? false)
        XCTAssertNil(Diagnostics.hostPort("https://relay.example.com"))
    }

    func testTheSharedTextNeverCarriesRoomsKeysOrCodes() {
        let leaky = "Could not connect: ws://r/relay?role=client&room=abcd1234abcd1234&key=00112233445566778899aabbccddeeff&pair=AB12CD"
        let reports = [
            RouteReport(url: "ws://192.168.1.20:4400", dns: ProbeStep(ok: true, ms: 0), tcp: ProbeStep(ok: false, ms: 3, detail: leaky)),
            RouteReport(url: "ws://studio.tail1234.ts.net:4400", dns: ProbeStep(ok: true, ms: 8, detail: "100.101.102.103"),
                        tcp: ProbeStep(ok: true, ms: 20), hello: ProbeStep(ok: true, ms: 51, detail: "Your computer answered")),
        ]
        var log = ConnectionLog()
        log.record(.connecting, detail: leaky, at: Date(timeIntervalSince1970: 0))
        let text = Diagnostics.text(app: "1.2.3 (45), iOS 26.0", network: .local, routeInUse: "ws://studio.tail1234.ts.net:4400",
                                    reports: reports, log: log.text(relayHost: "studio.tail1234.ts.net:4400", route: .tailscale),
                                    at: Date(timeIntervalSince1970: 0))
        for secret in ["abcd1234abcd1234", "00112233445566778899aabbccddeeff", "AB12CD"] {
            XCTAssertFalse(text.contains(secret), "\(secret) leaked:\n\(text)")
        }
        XCTAssertTrue(text.contains("Route in use: studio.tail1234.ts.net:4400 (tailscale)"))
        XCTAssertTrue(text.contains("Route 192.168.1.20:4400 (lan): problem"))
        XCTAssertTrue(text.contains("  hello: skipped"))
        XCTAssertTrue(text.contains("  hello: ok 51 ms – Your computer answered"))
        XCTAssertTrue(text.contains("Network: local"))
    }

    // MARK: The real network calls, on this machine

    func testResolvesLocalhostAndANumericAddress() async throws {
        let net = PosixProbeNetwork()
        let found = try await net.resolve("localhost", timeout: 3)
        XCTAssertTrue(found.contains("127.0.0.1") || found.contains("::1"), "\(found)")
        let literal = try await net.resolve("127.0.0.1", timeout: 3)
        XCTAssertEqual(literal, ["127.0.0.1"])
    }

    func testConnectsToAListeningPortAndNotToAClosedOne() async throws {
        let (fd, port) = try listen()
        defer { _ = close(fd) }
        let net = PosixProbeNetwork()
        try await net.connect("127.0.0.1", port: port, timeout: 2)
        _ = close(fd)
        do {
            try await net.connect("127.0.0.1", port: port, timeout: 2)
            XCTFail("a closed port connected")
        } catch {
            XCTAssertFalse(error.localizedDescription.isEmpty)
        }
    }

    /// A TCP listener on 127.0.0.1 with a free port.
    func listen() throws -> (Int32, Int) {
        #if canImport(Glibc)
        let fd = socket(AF_INET, Int32(SOCK_STREAM.rawValue), 0)
        #else
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        #endif
        guard fd >= 0 else { throw RelayError("socket") }
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        addr.sin_port = 0
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        let ok = withUnsafePointer(to: &addr) { p in
            p.withMemoryRebound(to: sockaddr.self, capacity: 1) { Glibc_or_Darwin_bind(fd, $0, len) == 0 }
        }
        guard ok, Glibc_or_Darwin_listen(fd) == 0 else { throw RelayError("bind/listen") }
        _ = withUnsafeMutablePointer(to: &addr) { p in
            p.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &len) }
        }
        return (fd, Int(UInt16(bigEndian: addr.sin_port)))
    }
}

private func Glibc_or_Darwin_listen(_ fd: Int32) -> Int32 {
    #if canImport(Glibc)
    return Glibc.listen(fd, 4)
    #else
    return Darwin.listen(fd, 4)
    #endif
}

/// `bind(2)`: inside an XCTestCase on Darwin, a bare `bind` is NSObject's KVO method.
private func Glibc_or_Darwin_bind(_ fd: Int32, _ addr: UnsafePointer<sockaddr>, _ len: socklen_t) -> Int32 {
    #if canImport(Glibc)
    return Glibc.bind(fd, addr, len)
    #else
    return Darwin.bind(fd, addr, len)
    #endif
}
