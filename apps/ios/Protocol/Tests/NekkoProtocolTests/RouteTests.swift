import Foundation
import XCTest
@testable import NekkoProtocol

/// TASKS.md IO-20: which address of a computer's relay to dial, and the
/// client moving between them.
final class RouteSupervisorTests: XCTestCase {
    let lan = "ws://192.168.1.20:4400"
    let tailnet = "ws://studio.tail1234.ts.net:4400"
    let hosted = "wss://relay.example.com"
    let t0 = Date(timeIntervalSince1970: 1_000_000)

    func rules() -> RouteRules {
        var r = RouteRules()
        r.successesToReturn = 3
        r.failureCooldown = 60
        r.minDwell = 30
        return r
    }

    func testOrdersTheLanFirstThenTheTailnetThenTheInternet() {
        XCTAssertEqual(RouteSupervisor.order([hosted, tailnet, lan, tailnet]), [lan, tailnet, hosted])
        XCTAssertEqual(RouteSupervisor.order([tailnet, "ws://100.101.102.103:4400"]), [tailnet, "ws://100.101.102.103:4400"])
        XCTAssertEqual(RouteSupervisor(routes: [tailnet, lan], now: t0).url, lan)
    }

    func testOneRouteNeverMovesOrCools() {
        var s = RouteSupervisor(routes: [tailnet], rules: rules(), now: t0)
        XCTAssertFalse(s.hasAlternatives)
        XCTAssertFalse(s.fallbackExists)
        XCTAssertFalse(s.failed(now: t0).changed)
        XCTAssertEqual(s.routeToDial(now: t0), tailnet)
        XCTAssertTrue(s.onBest)
    }

    func testAFailureMovesDownAtOnceAndCoolsTheRouteDown() {
        var s = RouteSupervisor(routes: [tailnet, lan], rules: rules(), now: t0)
        XCTAssertTrue(s.fallbackExists, "the LAN dial gets the short open timeout")
        let r = s.failed(now: t0)
        XCTAssertEqual(r.changed, true)
        XCTAssertEqual(r.ready, true)
        XCTAssertEqual(s.url, tailnet)
        XCTAssertFalse(s.fallbackExists, "the last resort keeps the transport's own timeout")
        // The LAN is cooling: nothing to probe yet.
        XCTAssertNil(s.probeTarget(now: t0.addingTimeInterval(59)))
        XCTAssertEqual(s.probeTarget(now: t0.addingTimeInterval(61)), 0)
        // The tailnet failing too goes back to the LAN, but it is still cooling: not at once.
        let again = s.failed(now: t0.addingTimeInterval(1))
        XCTAssertEqual(again.changed, true)
        XCTAssertEqual(again.ready, false)
        XCTAssertEqual(s.url, lan)
    }

    func testMovesBackOnlyAfterEnoughProbesAndTheDwell() {
        var s = RouteSupervisor(routes: [tailnet, lan], rules: rules(), now: t0)
        s.failed(now: t0)
        let t = t0.addingTimeInterval(61)
        s.probed(0, ok: true, now: t)
        s.probed(0, ok: true, now: t)
        XCTAssertFalse(s.shouldMoveBack(now: t), "two successes are not enough")
        s.probed(0, ok: true, now: t)
        XCTAssertTrue(s.shouldMoveBack(now: t))
        // The dwell: just after a move, stay put however good the probes.
        var fresh = RouteSupervisor(routes: [tailnet, lan], rules: rules(), now: t0)
        fresh.failed(now: t0)
        var r = rules()
        r.failureCooldown = 1
        var short = RouteSupervisor(routes: [tailnet, lan], rules: r, now: t0)
        short.failed(now: t0)
        let soon = t0.addingTimeInterval(5)
        for _ in 0..<5 { short.probed(0, ok: true, now: soon) }
        XCTAssertFalse(short.shouldMoveBack(now: soon), "30 s dwell")
        XCTAssertTrue(short.shouldMoveBack(now: t0.addingTimeInterval(31)))
        XCTAssertEqual(short.moveBack(now: t0.addingTimeInterval(31)), lan)
        XCTAssertTrue(short.onBest)
        XCTAssertNil(fresh.probeTarget(now: t0))
    }

    func testAFailedProbeStartsTheCountAgainAndCoolsTheRoute() {
        var r = rules()
        r.minDwell = 0
        var s = RouteSupervisor(routes: [tailnet, lan], rules: r, now: t0)
        s.failed(now: t0)
        let t = t0.addingTimeInterval(61)
        s.probed(0, ok: true, now: t)
        s.probed(0, ok: true, now: t)
        s.probed(0, ok: false, now: t)
        XCTAssertNil(s.probeTarget(now: t), "cooling again")
        let later = t.addingTimeInterval(61)
        s.probed(0, ok: true, now: later)
        s.probed(0, ok: true, now: later)
        XCTAssertFalse(s.shouldMoveBack(now: later))
        s.probed(0, ok: true, now: later)
        XCTAssertTrue(s.shouldMoveBack(now: later))
        // A probe of anything else is ignored.
        s.probed(1, ok: false, now: later)
        XCTAssertTrue(s.shouldMoveBack(now: later))
    }

    func testCellularSkipsTheLanAndANetworkChangeStartsAfresh() {
        var s = RouteSupervisor(routes: [tailnet, lan], rules: rules(), path: .cellular, now: t0)
        XCTAssertEqual(s.url, tailnet)
        XCTAssertTrue(s.onBest)
        XCTAssertFalse(s.failed(now: t0).changed, "the LAN is no fallback on cellular")
        // Back on Wi-Fi: the LAN first again.
        XCTAssertTrue(s.pathChanged(.local, now: t0))
        XCTAssertEqual(s.url, lan)
        // A failure on this Wi-Fi cools the LAN; joining another clears it.
        s.failed(now: t0)
        XCTAssertEqual(s.url, tailnet)
        XCTAssertTrue(s.pathChanged(.local, now: t0.addingTimeInterval(1)))
        XCTAssertEqual(s.url, lan)
        // Leaving Wi-Fi while on the LAN: the next dial takes the tailnet.
        _ = s.pathChanged(.cellular, now: t0.addingTimeInterval(2))
        XCTAssertEqual(s.routeToDial(now: t0.addingTimeInterval(2)), tailnet)
    }
}

/// The client against the fake relay, with two routes to it.
extension RelayClientTests {
    final class FakeProber: RouteProber, @unchecked Sendable {
        let lock = NSLock()
        var up = true
        var probes: [String] = []
        func reachable(_ relayUrl: String, timeout: TimeInterval) async -> Bool {
            lock.sync {
                probes.append(relayUrl)
                return up
            }
        }
    }

    static let lanRoute = "ws://192.168.1.20:4400"
    static let tailnetRoute = "ws://studio.tail1234.ts.net:4400"

    func twoRoutes(_ relay: FakeRelay, prober: FakeProber? = nil, dwell: TimeInterval = 0.05) -> (RelayClient, Recorder) {
        var cfg = RelayConfig(relayUrl: Self.tailnetRoute, room: "abcd1234", key: "k", keyBytes: key, deviceId: "dev-1", deviceName: "iPhone")
        cfg.alternates = [Self.lanRoute]
        cfg.handshakeTimeout = 2
        cfg.requestTimeout = 5
        cfg.retryBase = 0.02
        cfg.retryMax = 0.08
        cfg.offlinePoll = 0.04
        var rules = RouteRules()
        rules.openTimeout = 0.1
        rules.probeInterval = 0.02
        rules.failureCooldown = 0.1
        rules.minDwell = dwell
        rules.successesToReturn = 3
        cfg.routeRules = rules
        let c = RelayClient(config: cfg, transport: relay, prober: prober)
        let r = Recorder()
        r.attach(c)
        return (c, r)
    }

    func testPrefersTheLanWhenItAnswers() async {
        let relay = FakeRelay(key: key, known: ["dev-1"])
        let (c, r) = twoRoutes(relay)
        c.connect()
        let s = await r.await(.online)
        XCTAssertEqual(s?.route, Self.lanRoute)
        XCTAssertEqual(c.route, Self.lanRoute)
        XCTAssertTrue(relay.sync { relay.urls.first?.hasPrefix("ws://192.168.1.20:4400/relay?") ?? false })
        c.close()
    }

    func testAHangingLanFallsBackToTheTailnetWithinTheOpenTimeout() async {
        let relay = FakeRelay(key: key, known: ["dev-1"])
        relay.unreachable["192.168.1.20:4400"] = true
        let (c, r) = twoRoutes(relay)
        let start = Date()
        c.connect()
        let s = await r.await(.online)
        XCTAssertEqual(s?.route, Self.tailnetRoute)
        XCTAssertLessThan(Date().timeIntervalSince(start), 1.5, "not the transport's 20 s")
        let answer = try? await c.call("app:info")
        XCTAssertEqual(answer?.string, "ok:app:info")
        c.close()
    }

    func testARefusingLanFallsBackAtOnce() async {
        let relay = FakeRelay(key: key, known: ["dev-1"])
        relay.unreachable["192.168.1.20:4400"] = false
        let (c, r) = twoRoutes(relay)
        c.connect()
        let s = await r.await(.online)
        XCTAssertEqual(s?.route, Self.tailnetRoute)
        XCTAssertEqual(relay.sync { relay.urls.count }, 2)
        c.close()
    }

    func testLeavingTheLanMovesToTheTailnetThenBackWhenItAnswersAgain() async {
        let relay = FakeRelay(key: key, known: ["dev-1"])
        let prober = FakeProber()
        prober.up = false
        let (c, r) = twoRoutes(relay, prober: prober)
        c.connect()
        await r.await({ $0.state == .online && $0.route == Self.lanRoute })
        // The LAN goes away under an open socket.
        relay.sync { relay.unreachable["192.168.1.20:4400"] = true }
        relay.sync { relay.current }?.drop(1006, "network down")
        await r.await({ $0.state == .online && $0.route == Self.tailnetRoute })
        // Probes keep failing: it stays put.
        try? await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(c.route, Self.tailnetRoute)
        XCTAssertFalse(prober.lock.sync { prober.probes.isEmpty }, "the LAN is probed once its cooldown ends")
        XCTAssertTrue(prober.lock.sync { prober.probes.allSatisfy { $0 == Self.lanRoute } })
        // The LAN is back: three good probes and the dwell, then it moves.
        relay.sync { relay.unreachable = [:] }
        prober.lock.sync { prober.up = true }
        await r.await({ $0.state == .online && $0.route == Self.lanRoute }, timeout: 4)
        XCTAssertEqual(c.route, Self.lanRoute)
        c.close()
    }

    func testNeverChangesRouteUnderARequestInFlight() async {
        let relay = FakeRelay(key: key, known: ["dev-1"])
        relay.unreachable["192.168.1.20:4400"] = false
        // chat:send answers only when the turn is over: here, never.
        relay.answer = { req in req.str("channel") == "chat:send" ? nil : ["type": "res", "id": req["id"]!, "result": "ok"] }
        let prober = FakeProber()
        let (c, r) = twoRoutes(relay, prober: prober)
        c.connect()
        await r.await({ $0.state == .online && $0.route == Self.tailnetRoute })
        relay.sync { relay.unreachable = [:] }
        let turn = Task { try? await c.call("chat:send", [], timeout: 1) }
        try? await Task.sleep(nanoseconds: 600_000_000)
        XCTAssertEqual(c.route, Self.tailnetRoute, "a running turn is never cut to change route")
        _ = await turn.value
        await r.await({ $0.state == .online && $0.route == Self.lanRoute }, timeout: 4)
        c.close()
    }

    func testOnCellularItDialsTheTailnetAndBackOnWiFiTheLan() async {
        let relay = FakeRelay(key: key, known: ["dev-1"])
        let (c, r) = twoRoutes(relay)
        c.connect()
        await r.await({ $0.state == .online && $0.route == Self.lanRoute })
        c.networkChanged(.cellular)
        await r.await({ $0.state == .online && $0.route == Self.tailnetRoute })
        c.networkChanged(.local)
        await r.await({ $0.state == .online && $0.route == Self.lanRoute })
        c.close()
    }

    func testAnOfflineComputerIsNotARouteFailure() async {
        let relay = FakeRelay(key: key, known: ["dev-1"])
        relay.refuseNext = (1008, "room not paired (agent offline)")
        let (c, r) = twoRoutes(relay)
        c.connect()
        let s = await r.await(.offline)
        XCTAssertEqual(s?.route, Self.lanRoute, "the relay answered on the LAN; the computer is away, not the path")
        await r.await({ $0.state == .online && $0.route == Self.lanRoute })
        c.close()
    }
}

final class PairingFixtureTests: XCTestCase {
    struct Case: Decodable {
        struct Link: Decodable, Equatable {
            let relayUrl: String
            let room: String
            let key: String
            let pair: String?
            let alts: [String]
        }
        let input: String
        let link: Link?
    }

    /// The fixture `packages/shared/src/pairing-link.golden.test.ts` writes from
    /// the computer's parser: this one must agree on every case.
    func testParsesTheSharedFixtureLikeTheComputer() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "pairing-links", withExtension: "json", subdirectory: "Fixtures"))
        let cases = try JSONDecoder().decode([Case].self, from: Data(contentsOf: url))
        XCTAssertGreaterThan(cases.count, 5)
        for c in cases {
            let got = Pairing.parse(c.input).map {
                Case.Link(relayUrl: $0.relayUrl, room: $0.room, key: $0.key, pair: $0.pair, alts: $0.alts)
            }
            XCTAssertEqual(got, c.link, c.input)
        }
    }

    func testDescriptionCountsRoutesButNeverPrintsTheKey() {
        let l = PairingLink(relayUrl: "ws://a.ts.net:4400", room: "abcd1234", key: "00112233445566778899aabbccddeeff",
                            alts: ["ws://192.168.1.20:4400"])
        XCTAssertFalse(l.description.contains(l.key))
        XCTAssertTrue(l.description.contains("alts=1"))
    }
}
