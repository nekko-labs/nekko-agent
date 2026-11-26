import XCTest
@testable import NekkoProtocol

/// The reconnect backoff is 1, 2, 4 ... 30 s plus 0 to 50% jitter, so a relay
/// restart does not bring every phone back in the same instant (#3385).
final class RelayBackoffTests: XCTestCase {
    private func config(_ random: @escaping @Sendable () -> Double) -> RelayConfig {
        var cfg = RelayConfig(relayUrl: "wss://r", room: "a", key: "k", hostKey: "h", keyBytes: Data(), deviceId: "d", deviceName: "n")
        cfg.jitterSource = random
        return cfg
    }

    func testNoJitterKeepsTheDoublingScheduleAndItsCap() {
        let cfg = config { 0 }
        XCTAssertEqual((0..<8).map { cfg.retryDelay(attempt: $0) }, [1, 2, 4, 8, 16, 30, 30, 30])
    }

    func testJitterAddsUpToHalf() {
        let top = config { 0.999999 }
        XCTAssertEqual(top.retryDelay(attempt: 2), 4 * 1.5, accuracy: 0.001)
        let mid = config { 0.5 }
        XCTAssertEqual(mid.retryDelay(attempt: 0), 1.25, accuracy: 1e-9)
        XCTAssertEqual(mid.retryDelay(attempt: 50), 37.5, accuracy: 1e-9, "the cap is jittered too, so capped clients still spread")
    }

    func testRealRandomnessSpreadsClientsWithinBounds() {
        let cfg = RelayConfig(relayUrl: "wss://r", room: "a", key: "k", hostKey: "h", keyBytes: Data(), deviceId: "d", deviceName: "n")
        let delays = (0..<200).map { _ in cfg.retryDelay(attempt: 3) }
        XCTAssertTrue(delays.allSatisfy { $0 >= 8 && $0 < 12 })
        XCTAssertGreaterThan(Set(delays).count, 100, "200 phones do not pick the same instant")
    }

    func testAnOutOfRangeSourceIsClamped() {
        XCTAssertEqual(config { 7 }.retryDelay(attempt: 0), 1.5, accuracy: 1e-9)
        XCTAssertEqual(config { -3 }.retryDelay(attempt: 0), 1, accuracy: 1e-9)
    }
}
