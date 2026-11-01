import Foundation
import XCTest
@testable import NekkoProtocol

final class ConnectionLogTests: XCTestCase {
    func testRetriesFoldIntoOneEntryAndTheLogStaysBounded() {
        var log = ConnectionLog()
        let t0 = Date(timeIntervalSince1970: 0)
        log.record(.connecting, at: t0)
        log.record(.connecting, detail: "handshake timed out", at: t0)
        log.record(.connecting, detail: "handshake timed out", at: t0)
        log.record(.online, at: t0.addingTimeInterval(5))
        XCTAssertEqual(log.entries.map(\.state), [.connecting, .connecting, .online])
        XCTAssertEqual(log.entries[1].repeats, 2)
        XCTAssertEqual(log.lastOnline, t0.addingTimeInterval(5))
        for i in 0..<(ConnectionLog.capacity * 2) { log.record(i.isMultiple(of: 2) ? .offline : .connecting, at: t0) }
        XCTAssertEqual(log.entries.count, ConnectionLog.capacity)
        XCTAssertEqual(Set(log.entries.map(\.id)).count, ConnectionLog.capacity, "ids stay unique")
    }

    func testTheCopiedTextHoldsOnlyTheHostStatesAndDetails() {
        var log = ConnectionLog()
        log.record(.connecting, detail: "relay closed (1006)", at: Date(timeIntervalSince1970: 0))
        log.record(.denied, detail: "bad-key", denied: .badKey, at: Date(timeIntervalSince1970: 1))
        let text = log.text(relayHost: "studio.tail1234.ts.net", route: .tailscale)
        XCTAssertEqual(text, """
        Relay: studio.tail1234.ts.net (tailscale)
        1970-01-01T00:00:00Z connecting – relay closed (1006)
        1970-01-01T00:00:01Z denied [bad-key]
        """)
    }

    func testAdviceFollowsTheRouteAndState() {
        let ask = { (route: RelayRoute, state: RelayState, denied: DenyReason?, tailscale: Bool) in
            ConnectionAdvice.advise(route: route, relayHost: "h", computer: "Studio", state: state, denied: denied, detail: nil, tailscaleOn: tailscale)
        }
        XCTAssertEqual(ask(.tailscale, .online, nil, true), [])
        XCTAssertTrue(ask(.tailscale, .connecting, nil, false).first?.hasPrefix("Tailscale is off") == true)
        XCTAssertTrue(ask(.tailscale, .connecting, nil, true).first?.hasPrefix("Tailscale is on") == true)
        XCTAssertTrue(ask(.lan, .connecting, nil, false).contains { $0.contains("same Wi-Fi") })
        XCTAssertTrue(ask(.internet, .offline, nil, true).first?.contains("isn’t connected to it") == true)
        XCTAssertTrue(ask(.internet, .denied, .badCode, true).first?.contains("10 minutes") == true)
        XCTAssertTrue(ask(.internet, .denied, .revoked, true).first?.contains("removed this iPhone") == true)
        let cert = ConnectionAdvice.advise(route: .internet, relayHost: "h", computer: "Studio", state: .connecting, denied: nil,
                                           detail: "TLS certificate not trusted", tailscaleOn: false)
        XCTAssertTrue(cert.contains { $0.contains("certificate") })
    }

    func testAGoneRelayNameSaysPairAgainNotCheckTheInternet() {
        let gone = ConnectionAdvice.advise(route: .internet, relayHost: "relay.example", computer: "Studio", state: .connecting,
                                           denied: nil, detail: RelayStatus.hostNotFound, tailscaleOn: false)
        XCTAssertTrue(gone.first?.contains("relay.example doesn’t exist") == true)
        XCTAssertTrue(gone.contains { $0.contains("pair this iPhone again") })
        XCTAssertFalse(gone.contains { $0.hasPrefix("Check this iPhone is online") })
    }
}

final class TailscaleAppTests: XCTestCase {
    func testOfferedOnlyWhenTheTailnetRouteIsDownOnThisPhone() {
        XCTAssertTrue(TailscaleApp.shouldOffer(route: .tailscale, tailscaleOn: false, state: .connecting))
        XCTAssertTrue(TailscaleApp.shouldOffer(route: .tailscale, tailscaleOn: false, state: .offline))
        XCTAssertFalse(TailscaleApp.shouldOffer(route: .tailscale, tailscaleOn: true, state: .connecting), "Tailscale is on: the computer is the problem")
        XCTAssertFalse(TailscaleApp.shouldOffer(route: .tailscale, tailscaleOn: false, state: .online))
        XCTAssertFalse(TailscaleApp.shouldOffer(route: .tailscale, tailscaleOn: false, state: .denied), "pairing again is the fix, not Tailscale")
        XCTAssertFalse(TailscaleApp.shouldOffer(route: .internet, tailscaleOn: false, state: .connecting))
        XCTAssertFalse(TailscaleApp.shouldOffer(route: .lan, tailscaleOn: false, state: .connecting))
    }

    func testOpensTheAppOrItsAppStorePage() {
        XCTAssertEqual(TailscaleApp.destination(installed: true).absoluteString, "tailscale://")
        XCTAssertEqual(TailscaleApp.destination(installed: false).host, "apps.apple.com")
        XCTAssertEqual(TailscaleApp.appURL.scheme, TailscaleApp.scheme)
    }

    func testOpenFallsBackToTheAppStore() {
        var opened: [URL] = []
        XCTAssertEqual(TailscaleApp.open(canOpen: { _ in true }, open: { opened.append($0) }), TailscaleApp.appURL)
        XCTAssertEqual(TailscaleApp.open(canOpen: { _ in false }, open: { opened.append($0) }), TailscaleApp.appStoreURL)
        XCTAssertEqual(opened, [TailscaleApp.appURL, TailscaleApp.appStoreURL])
    }
}
