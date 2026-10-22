import Foundation
import XCTest
@testable import NekkoProtocol

/// IO-30 and IO-32: the protocol version check, push kinds, the relay's own
/// frames and how *Send a test notification* decides its path.
final class PhoneProtocolTests: XCTestCase {
    func testTheWelcomeVersionAndWhichSideToUpdate() {
        XCTAssertEqual(PhoneProtocol.of(welcome: ["type": "welcome", "protocol": 2]), 2)
        // A computer from before the field, or nonsense: version 1.
        XCTAssertEqual(PhoneProtocol.of(welcome: ["type": "welcome"]), 1)
        XCTAssertEqual(PhoneProtocol.of(welcome: ["type": "welcome", "protocol": "2"]), 1)
        XCTAssertEqual(PhoneProtocol.of(welcome: ["type": "welcome", "protocol": -4]), 1)

        XCTAssertEqual(ProtocolCheck.compare(phone: 2, computer: nil), .same)
        XCTAssertEqual(ProtocolCheck.compare(phone: 2, computer: 2), .same)
        XCTAssertEqual(ProtocolCheck.compare(phone: 2, computer: 1), .updateComputer)
        XCTAssertEqual(ProtocolCheck.compare(phone: 2, computer: 3), .updatePhone)
        XCTAssertNil(ProtocolCheck.same.message(computer: "Studio"))
        XCTAssertEqual(ProtocolCheck.updateComputer.message(computer: "Studio"),
                       "Nekko Agent on Studio is older than this app. Update it on the computer to use everything here.")
        XCTAssertTrue(ProtocolCheck.updatePhone.message(computer: "Studio")!.contains("App Store"))
    }

    func testPushKindsOfEvents() {
        XCTAssertEqual(PushKind.choosable.map(\.rawValue), ["needs-you", "finished", "failed"])
        XCTAssertEqual(PushKind.of(.question(sessionId: "s", request: AskRequest.from(["callId": "q", "questions": []])!)), .needsYou)
        XCTAssertEqual(PushKind.of(.done(sessionId: "s", messageId: nil)), .finished)
        XCTAssertEqual(PushKind.of(.error(sessionId: "s", message: "rate limited")), .failed)
        // Stopping a run is not a failure.
        XCTAssertNil(PushKind.of(.error(sessionId: "s", message: "Stopped")))
        XCTAssertNil(PushKind.of(.text(sessionId: "s", delta: "x")))
    }

    func testTheRelaysOwnFrames() {
        XCTAssertEqual(RelayControl.parse(["type": "push-registered", "delivers": true]), .pushRegistered(delivers: true))
        XCTAssertEqual(RelayControl.parse(["type": "push-registered"]), .pushRegistered(delivers: false))
        let tag = E2E.activityTag("s1")
        XCTAssertEqual(RelayControl.parse(["type": "dismiss", "tag": .string(tag)]), .dismiss(tag: tag))
        XCTAssertNil(RelayControl.parse(["type": "dismiss", "tag": "s1"]))
        XCTAssertNil(RelayControl.parse(["type": "agent-online"]))
    }

    func testTheTestNotificationsPath() {
        XCTAssertEqual(TestPushResult.decide(computerAnswered: true, hasToken: true, relayDelivers: true), .relay)
        XCTAssertEqual(TestPushResult.decide(computerAnswered: true, hasToken: true, relayDelivers: false), .local(.relayCannotPush))
        XCTAssertEqual(TestPushResult.decide(computerAnswered: true, hasToken: true, relayDelivers: nil), .local(.relayDidNotSay))
        XCTAssertEqual(TestPushResult.decide(computerAnswered: true, hasToken: false, relayDelivers: true), .local(.noToken))
        XCTAssertEqual(TestPushResult.decide(computerAnswered: false, hasToken: true, relayDelivers: true), .local(.computerTooOld))
        XCTAssertTrue(TestPushResult.unknownToComputer("Not allowed from a paired phone (channel-denied): push:test"))
        XCTAssertTrue(TestPushResult.unknownToComputer("Unknown channel: push:test"))
        XCTAssertFalse(TestPushResult.unknownToComputer("push:test: timed out"))
        XCTAssertEqual(TestPushResult.relay.message(computer: "Studio", relayHost: "relay.example"),
                       "Sent from Studio through relay.example by Apple push. It should arrive in a few seconds.")
        XCTAssertTrue(TestPushResult.local(.relayCannotPush).message(computer: "Studio", relayHost: "100.64.0.1").contains("no Apple push key"))
    }
}
