import Foundation
import XCTest
@testable import NekkoKit
@testable import NekkoProtocol

/// TASKS.md IO-20 and IO-21 in the store: every route of a computer kept and
/// handed to the client, the route in use shown, the background grace, and
/// the Connection screen's checks.
@MainActor
final class RouteStoreTests: XCTestCase {
    let room = "a1b2c3d4e5f60718"
    let key = "00112233445566778899aabbccddeeff"
    let tailnet = "ws://studio.tail1.ts.net:4400"
    let lan = "ws://192.168.1.20:4400"
    var connections: [FakeConnection] = []
    let secure = MemoryStore()
    var network = FakeProbeNetwork()
    /// New connections answer like an online computer as soon as they connect.
    var answerProbes = false

    struct FakeProbeNetwork: ProbeNetwork {
        var open: Set<String> = []
        func resolve(_ host: String, timeout: TimeInterval) async throws -> [String] {
            if host == "studio.tail1.ts.net" { return ["100.101.102.103"] }
            throw RelayError("unknown host")
        }
        func connect(_ address: String, port: Int, timeout: TimeInterval) async throws {
            guard open.contains("\(address):\(port)") else { throw RelayError("Connection refused") }
        }
    }

    func makeStore() -> ComputersStore {
        var n = 0
        return ComputersStore(
            store: secure,
            makeConnection: { cfg in
                let c = FakeConnection(config: cfg)
                if self.answerProbes { c.onConnect = { $0.status(RelayStatus(.online)) } }
                self.connections.append(c)
                return c
            },
            deviceName: { "iPhone" },
            deriveKey: { _, _ in Data(repeating: 7, count: 32) },
            newId: { n += 1; return "id-\(n)" },
            now: { 1_000 },
            summariesDebounce: 0.01,
            probeNetwork: network)
    }

    func settle(_ seconds: Double = 0.03) async {
        for _ in 0..<20 { await Task.yield() }
        try? await Task.sleep(nanoseconds: UInt64(seconds * 1e9))
        for _ in 0..<20 { await Task.yield() }
    }

    func testKeepsEveryRouteAndHandsThemToTheClient() async throws {
        let s = makeStore()
        s.load()
        await s.pair(PairingLink(relayUrl: tailnet, room: room, key: key, pair: "AB", alts: [lan]))
        XCTAssertEqual(s.active?.alts, [lan])
        XCTAssertEqual(s.active?.routes, [lan, tailnet], "the LAN first")
        XCTAssertEqual(connections.last?.config.relayUrl, tailnet)
        XCTAssertEqual(connections.last?.config.alternates, [lan])

        // Saved and read back; a later QR replaces the routes.
        let again = makeStore()
        again.load()
        XCTAssertEqual(again.active?.alts, [lan])
        await again.pair(PairingLink(relayUrl: tailnet, room: room, key: key, alts: ["ws://10.0.0.5:4400"]))
        XCTAssertEqual(again.computers.count, 1)
        XCTAssertEqual(again.active?.alts, ["ws://10.0.0.5:4400"])
    }

    func testReadsPairingsSavedBeforeRoutes() throws {
        secure.set(ComputersStore.indexKey, #"[{"id":"old","name":"Mac","relayUrl":"wss://r.example","pairedAt":1}]"#)
        let s = makeStore()
        s.load()
        XCTAssertEqual(s.computers.first?.alts, [])
        XCTAssertEqual(s.computers.first?.routes, ["wss://r.example"])
    }

    func testShowsTheRouteInUseAndLogsItWhenThereAreSeveral() async throws {
        let s = makeStore()
        s.load()
        await s.pair(PairingLink(relayUrl: tailnet, room: room, key: key, alts: [lan]))
        let c = try XCTUnwrap(connections.last)
        c.status(RelayStatus(.connecting, route: lan))
        c.status(RelayStatus(.connecting, detail: "192.168.1.20:4400 didn’t answer", route: tailnet))
        c.status(RelayStatus(.online, route: tailnet))
        await settle()
        XCTAssertEqual(s.route, tailnet)
        XCTAssertEqual(s.connectionLog.entries.map(\.via), [nil, "192.168.1.20:4400", "studio.tail1.ts.net:4400", "studio.tail1.ts.net:4400"])
        XCTAssertTrue(s.connectionLog.text(relayHost: "h", route: .tailscale).contains("online via studio.tail1.ts.net:4400"))
    }

    func testForwardsNetworkChangesWithThePath() async throws {
        let s = makeStore()
        s.load()
        await s.pair(PairingLink(relayUrl: tailnet, room: room, key: key, alts: [lan]))
        s.networkChanged(.cellular)
        XCTAssertEqual(connections.last?.paths, [.cellular])
        // A new connection learns the path the phone is on.
        s.connect(try XCTUnwrap(s.activeId))
        XCTAssertEqual(connections.last?.paths, [.cellular])
    }

    func testKeepsAHealthySocketThroughTheGraceThenClosesIt() async throws {
        let s = makeStore()
        s.load()
        await s.pair(PairingLink(relayUrl: tailnet, room: room, key: key))
        let c = try XCTUnwrap(connections.last)
        c.online()
        await settle()
        s.enterBackground(grace: 0.15)
        await settle(0.05)
        XCTAssertFalse(c.closed, "kept during the grace")
        await settle(0.2)
        XCTAssertTrue(c.closed, "closed after it")
        XCTAssertTrue(s.suspended)
        // Foreground: the same client dials again, nothing reloaded from scratch.
        let before = c.connects
        s.nudge()
        XCTAssertFalse(s.suspended)
        XCTAssertEqual(c.connects, before + 1)
        XCTAssertEqual(connections.count, 1)
    }

    func testABriefSwitchKeepsTheSocketAndABrokenOneClosesAtOnce() async throws {
        let s = makeStore()
        s.load()
        await s.pair(PairingLink(relayUrl: tailnet, room: room, key: key))
        let c = try XCTUnwrap(connections.last)
        c.online()
        await settle()
        s.enterBackground(grace: 0.1)
        s.resume()
        await settle(0.2)
        XCTAssertFalse(c.closed, "back before the grace ran out")
        XCTAssertFalse(s.suspended)

        c.status(RelayStatus(.connecting, detail: "closed (1006)"))
        await settle()
        s.enterBackground(grace: 30)
        XCTAssertTrue(c.closed, "no retrying in the background")
        XCTAssertTrue(s.suspended)
    }

    func testChecksEveryRouteAndSaysHelloOnItsOwnSocket() async throws {
        network.open = ["100.101.102.103:4400"]
        let s = makeStore()
        s.load()
        await s.pair(PairingLink(relayUrl: tailnet, room: room, key: key, pair: "AB", alts: [lan]))
        let live = try XCTUnwrap(connections.last)
        answerProbes = true
        await s.runChecks()
        XCTAssertEqual(s.checks.map(\.url), [lan, tailnet])
        let lanReport = s.checks[0]
        XCTAssertEqual(lanReport.tcp?.ok, false)
        XCTAssertNil(lanReport.hello)
        let tail = s.checks[1]
        XCTAssertEqual(tail.dns?.detail, "100.101.102.103")
        XCTAssertEqual(tail.tcp?.ok, true)
        XCTAssertEqual(tail.hello?.ok, true)
        XCTAssertEqual(tail.hello?.detail, "My computer answered")
        // The probe socket is not the live one, never carries the code, and is closed.
        let probe = try XCTUnwrap(connections.last)
        XCTAssertFalse(probe === live)
        XCTAssertNil(probe.config.pairCode)
        XCTAssertEqual(probe.config.relayUrl, tailnet)
        XCTAssertTrue(probe.closed)
        XCTAssertFalse(live.closed)

        let text = s.diagnosticsText(app: "1.0 (1)")
        XCTAssertFalse(text.contains(key))
        XCTAssertFalse(text.contains(room))
        XCTAssertTrue(text.contains("Route 192.168.1.20:4400 (lan): problem"))
    }
}
