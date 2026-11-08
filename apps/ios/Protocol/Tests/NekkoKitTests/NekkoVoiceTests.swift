import XCTest
import NekkoProtocol
@testable import NekkoKit

@MainActor
final class NekkoVoiceTests: XCTestCase {
    private func context(online: Bool = true, targets: [NekkoVoiceDispatcher.Target] = [.init(id: "a", name: "Login")]) -> NekkoVoiceDispatcher.Context {
        .init(computerId: "pc", computerName: "Work Mac", online: online, loaded: true,
              card: .init(chats: [], focusId: "unrelated", more: 30, listening: false, heard: "",
                          counts: ["working": 3, "needsYou": 2, "done": 20, "watching": 4, "failed": 1]), targets: targets)
    }
    private func message(_ r: NekkoVoiceDispatcher.Result) -> String {
        guard case .message(let s) = r else { XCTFail("Unexpected side effect"); return "" }
        return s
    }
    func testStatusUsesScopedTotalsNotFocusedChatOrClippedRows() {
        let d = NekkoVoiceDispatcher()
        let reply = message(d.dispatch("status", context: context()))
        XCTAssertTrue(reply.contains("Work Mac: 3 Building, 2 Need input, 20 Done, 4 Watching, 1 Failed"))
        XCTAssertTrue(message(d.dispatch("status", context: context(online: false))).contains("Offline or stale"))
        var c = context()
        c.card.counts = nil
        XCTAssertTrue(message(d.dispatch("status", context: c)).contains("Partial counts"))
    }
    func testNoImplicitFocusAndSensitiveActionsNeverDispatch() {
        let d = NekkoVoiceDispatcher()
        for command in ["fix it", "approve all", "stop Login", "delete Login", "yes", "send to Login"] {
            XCTAssertTrue(message(d.dispatch(command, context: context())).contains("Not sent"))
        }
    }
    func testSendNeedsExactTargetAndRepeatedActionConfirmation() {
        let d = NekkoVoiceDispatcher()
        let c = context()
        XCTAssertTrue(message(d.dispatch("send to Login: Fix it", context: c)).contains("Nothing sent yet"))
        XCTAssertEqual(d.dispatch("confirm send to Login: Fix it", context: c), .send(computerId: "pc", sessionId: "a", text: "Fix it"))
        XCTAssertTrue(message(d.dispatch("confirm send to Login: Fix it", context: c)).contains("expired"), "confirmation is single use")
    }
    func testSpokenDelimiterDoesNotRequireDictatedPunctuation() {
        let d = NekkoVoiceDispatcher()
        let c = context()
        _ = d.dispatch("send to Login saying Fix it", context: c)
        XCTAssertEqual(d.dispatch("confirm send to Login saying Fix it", context: c), .send(computerId: "pc", sessionId: "a", text: "Fix it"))
    }
    func testAmbiguousNamesNeverChooseFirstAndNoSubstringMatching() {
        let d = NekkoVoiceDispatcher()
        let c = context(targets: [.init(id: "a", name: "Login"), .init(id: "b", name: "login")])
        XCTAssertTrue(message(d.dispatch("send to Login: Fix it", context: c)).contains("ambiguous"))
        XCTAssertTrue(message(d.dispatch("send to Log: Fix it", context: context())).contains("missing"))
    }
    func testStaleChangedScopeChangedMessageAndCancellationRejectConfirmation() {
        let d = NekkoVoiceDispatcher()
        let c = context()
        let now = Date()
        _ = d.dispatch("send to Login: Fix it", context: c, now: now)
        XCTAssertTrue(message(d.dispatch("confirm send to Login: Fix it", context: c, now: now.addingTimeInterval(61))).contains("expired"))
        _ = d.dispatch("send to Login: Fix it", context: c)
        var other = c; other.computerId = "other"
        XCTAssertTrue(message(d.dispatch("confirm send to Login: Fix it", context: other)).contains("changed"))
        _ = d.dispatch("send to Login: Fix it", context: c)
        XCTAssertTrue(message(d.dispatch("confirm send to Login: Delete it", context: c)).contains("changed"))
        _ = d.dispatch("send to Login: Fix it", context: c)
        d.cancel()
        XCTAssertTrue(message(d.dispatch("confirm send to Login: Fix it", context: c)).contains("expired"))
        _ = d.dispatch("send to Login: Fix it", context: c)
        let replaced = context(targets: [.init(id: "new-id", name: "Login")])
        XCTAssertTrue(message(d.dispatch("confirm send to Login: Fix it", context: replaced)).contains("changed"))
    }
    func testOfflineSendIsExplicitAndDoesNotClaimDelivery() {
        let d = NekkoVoiceDispatcher()
        let c = context(online: false)
        _ = d.dispatch("send to Login: Fix it", context: c)
        XCTAssertEqual(d.dispatch("confirm send to Login: Fix it", context: c), .send(computerId: "pc", sessionId: "a", text: "Fix it"))
        // Delivery wording is the integration's responsibility, not a dispatcher promise.
    }
    func testCaptureCancellationIgnoresLateResultAndPreventsOverlap() async {
        let r = NekkoVoiceRunner()
        var release: CheckedContinuation<String, Never>?
        var captures = 0
        var routes: [String] = []
        var shown: [String] = []
        r.capture = { captures += 1; return await withCheckedContinuation { release = $0 } }
        r.routeWithCommit = { text, _ in routes.append(text); return "Sent" }
        r.show = { _, text in shown.append(text) }
        let task = Task { await r.talk() }
        while release == nil { await Task.yield() }
        r.cancel()
        await r.talk()
        XCTAssertEqual(captures, 1, "cancelled capture owns the microphone until drained")
        release?.resume(returning: "late words")
        await task.value
        XCTAssertTrue(routes.isEmpty)
        XCTAssertEqual(shown.last, "Cancelled. Nothing sent.")
        XCTAssertFalse(r.busy)
        r.capture = { "status" }
        await r.talk()
        XCTAssertEqual(routes, ["status"])
    }
    func testDeliveryDenialIsNotSuccessAndEmptyCaptureDoesNotDispatch() async {
        let r = NekkoVoiceRunner()
        var routed = 0
        var shown: [String] = []
        r.show = { _, text in shown.append(text) }
        r.routeWithCommit = { _, _ in routed += 1; throw RelayError("Request denied") }
        r.capture = { "   " }
        await r.talk()
        XCTAssertEqual(routed, 0)
        XCTAssertEqual(shown.last, "No words heard. Nothing sent.")
        r.capture = { "confirm send to Login: Fix it" }
        await r.talk()
        XCTAssertEqual(routed, 1)
        XCTAssertEqual(shown.last, "Not sent. Voice capture or delivery failed. Open app to review.")
    }
    func testCancelAfterDispatchCannotClaimToRecallDelivery() async {
        let r = NekkoVoiceRunner()
        var release: CheckedContinuation<String, Never>?
        var shown: [String] = []
        r.capture = { "status" }
        r.routeWithCommit = { _, permit in
            XCTAssertTrue(permit.commit())
            return await withCheckedContinuation { release = $0 }
        }
        r.show = { _, text in shown.append(text) }
        let task = Task { await r.talk() }
        while release == nil { await Task.yield() }
        r.cancel()
        XCTAssertEqual(shown.last, "Sending…", "cannot claim nothing sent once delivery starts")
        release?.resume(returning: "Queued, not sent yet.")
        await task.value
        XCTAssertEqual(shown.last, "Queued, not sent yet.")
    }
    func testFinishFailureAndPrivacySafeDeliveryFeedback() async {
        let r = NekkoVoiceRunner()
        var release: CheckedContinuation<String, Never>?
        var shown: [String] = []
        r.capture = { await withCheckedContinuation { release = $0 } }
        r.finish = { release?.resume(returning: "private transcript") }
        r.routeWithCommit = { _, _ in "Queued, not sent yet." }
        r.show = { _, text in shown.append(text) }
        let task = Task { await r.talk() }
        while release == nil { await Task.yield() }
        r.finishListening()
        await task.value
        XCTAssertEqual(shown, ["", "Processing…", "Queued, not sent yet."])
        r.capture = { throw RelayError("Microphone denied: private transcript or credential") }
        await r.talk()
        XCTAssertEqual(shown.last, "Not sent. Voice capture or delivery failed. Open app to review.")
        XCTAssertFalse(shown.contains { $0.contains("private transcript or credential") })
    }
}
