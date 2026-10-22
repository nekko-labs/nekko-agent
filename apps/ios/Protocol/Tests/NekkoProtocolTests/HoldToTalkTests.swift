import Foundation
import XCTest
@testable import NekkoProtocol

final class HoldToTalkTests: XCTestCase {
    let t0 = Date(timeIntervalSince1970: 1_000)

    func testHoldSpeakAndLetGo() {
        var h = HoldToTalk()
        XCTAssertEqual(h.press(at: t0, permission: .granted), .start)
        XCTAssertTrue(h.holding)
        XCTAssertEqual(h.press(at: t0, permission: .granted), .none, "a second touch while holding does nothing")
        XCTAssertEqual(h.didStart(at: t0.addingTimeInterval(0.1)), .none)
        XCTAssertEqual(h.release(at: t0.addingTimeInterval(2)), .finish)
        XCTAssertFalse(h.holding)
        XCTAssertEqual(h.release(at: t0.addingTimeInterval(3)), .none)
    }

    func testATapIsThrownAway() {
        var h = HoldToTalk()
        _ = h.press(at: t0, permission: .granted)
        _ = h.didStart(at: t0)
        XCTAssertEqual(h.release(at: t0.addingTimeInterval(HoldToTalk.minSeconds - 0.1)), .discard)
    }

    func testLettingGoBeforeTheRecorderStarted() {
        var h = HoldToTalk()
        _ = h.press(at: t0, permission: .granted)
        XCTAssertEqual(h.release(at: t0.addingTimeInterval(0.05)), .none)
        XCTAssertEqual(h.didStart(at: t0.addingTimeInterval(0.2)), .discard)
        XCTAssertFalse(h.holding)
        // Ready for the next hold.
        XCTAssertEqual(h.press(at: t0.addingTimeInterval(1), permission: .granted), .start)
    }

    func testTheFirstPressOnlyAsksForTheMicrophone() {
        var h = HoldToTalk()
        XCTAssertEqual(h.press(at: t0, permission: .undetermined), .askPermission)
        XCTAssertFalse(h.holding)
        XCTAssertEqual(h.press(at: t0, permission: .denied), .none)
        XCTAssertEqual(h.press(at: t0, permission: .granted), .start)
        h.failedToStart()
        XCTAssertFalse(h.holding)
    }
}
