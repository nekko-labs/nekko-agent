@testable import NekkoKit
import NekkoProtocol
import XCTest

final class ConnectionNotesTests: XCTestCase {
    private func facts(_ id: String, _ state: RelayState, route: RelayRoute = .internet, detail: String? = nil,
                       denied: DenyReason? = nil, active: Bool = false, waiting: Int = 0,
                       check: ProtocolCheck = .same, disabled: Bool = false) -> ConnectionFacts {
        ConnectionFacts(id: id, name: id.capitalized, route: route, relayHost: "\(id).tail.ts.net", state: state, detail: detail,
                        denied: denied, active: active, disabled: disabled, protocolCheck: check, waiting: waiting)
    }

    func testEveryComputerOnlineSaysNothingButItsName() {
        let notes = ConnectionNotes.make([facts("studio", .online, active: true), facts("gomi", .online)], tailscaleOn: true)
        XCTAssertEqual(notes.map(\.name), ["Studio", "Gomi"])
        XCTAssertEqual(notes.map(\.tone), [.ok, .ok])
        XCTAssertTrue(notes.allSatisfy { $0.word == nil && !$0.opens })
        XCTAssertTrue(ConnectionNotes.problems(notes).isEmpty)
    }

    func testTailscaleOffLeadsAndTheBlockedComputerWaitsQuietly() {
        let notes = ConnectionNotes.make([facts("studio", .connecting, route: .tailscale, active: true, waiting: 2),
                                          facts("laptop", .offline)], tailscaleOn: false)
        XCTAssertEqual(notes.map(\.id), [ConnectionNote.tailscaleId, "studio", "laptop"])
        let ts = notes[0]
        XCTAssertEqual(ts.word, "Tailscale off")
        XCTAssertEqual(ts.line, "Turn on Tailscale to reach Studio.")
        XCTAssertEqual(ts.tail, "2 prompts wait to send.")
        XCTAssertEqual(ts.actions, [.openTailscale, .details])
        XCTAssertEqual(notes[1].tone, .waiting)
        XCTAssertNil(notes[1].word)
        XCTAssertEqual(notes[2].word, "offline")
        XCTAssertEqual(notes[2].actions, [.retry])
        XCTAssertFalse(notes[2].more, "the safety exits belong to the active computer")
    }

    func testTailscaleOnButSilentPutsTheWordOnTheComputer() {
        let notes = ConnectionNotes.make([facts("studio", .connecting, route: .tailscale, detail: "timeout", active: true)], tailscaleOn: true)
        XCTAssertEqual(notes.count, 1)
        XCTAssertEqual(notes[0].word, "no answer")
        XCTAssertEqual(notes[0].actions, [.retry, .openTailscale, .details])
        XCTAssertTrue(notes[0].more)
    }

    func testFirstDialSaysNothingUntilItFails() {
        let n = ConnectionNotes.make([facts("studio", .connecting, active: true)], tailscaleOn: true)[0]
        XCTAssertEqual(n.tone, .waiting)
        XCTAssertFalse(n.opens)
    }

    func testRefusedOffersOnlyPairAgain() {
        let n = ConnectionNotes.make([facts("gomi", .denied, denied: .revoked)], tailscaleOn: true)[0]
        XCTAssertEqual(n.tone, .danger)
        XCTAssertEqual(n.word, "refused")
        XCTAssertEqual(n.line, "Gomi removed this iPhone.")
        XCTAssertEqual(n.actions, [.pairAgain])
    }

    func testAChangedKeyIsNamedEvenWhileDialing() {
        let n = ConnectionNotes.make([facts("studio", .connecting, detail: RelayStatus.badPairingKey)], tailscaleOn: true)[0]
        XCTAssertEqual(n.word, "key changed")
        XCTAssertEqual(n.actions, [.pairAgain])
    }

    func testAVersionMismatchIsAWordOnAnOnlineComputer() {
        let n = ConnectionNotes.make([facts("studio", .online, active: true, check: .updateComputer)], tailscaleOn: true)[0]
        XCTAssertEqual(n.tone, .ok)
        XCTAssertEqual(n.word, "update")
        XCTAssertEqual(n.wordTone, .warning)
        XCTAssertEqual(n.line, "Studio runs an older Nekko Agent.")
        XCTAssertTrue(n.actions.isEmpty)
    }

    func testAComputerSwitchedOffIsNotAProblemAndNotBlockedByTailscale() {
        let notes = ConnectionNotes.make([facts("studio", .idle, route: .tailscale, disabled: true)], tailscaleOn: false)
        XCTAssertEqual(notes.count, 1)
        XCTAssertEqual(notes[0].tone, .off)
        XCTAssertFalse(notes[0].opens)
    }

    func testASafetyExitSaysWhatThisPhoneDid() {
        var f = facts("studio", .denied, active: true)
        f.exit = .stoppedRemote
        f.exitAt = 0
        let n = ConnectionNotes.make([f], tailscaleOn: true, time: { _ in "9:40" })[0]
        XCTAssertEqual(n.word, "stopped")
        XCTAssertEqual(n.line, "You stopped remote access here at 9:40.")
        XCTAssertEqual(n.actions, [.tryAgain, .details])
    }
}
