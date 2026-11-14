import XCTest
@testable import NekkoKit
import NekkoProtocol

@MainActor
final class CarSessionTests: XCTestCase {
    private var clock = Date(timeIntervalSince1970: 1_800_000_000)
    private var sent: [(String, String)] = []
    private var answered: [(String, String, Bool)] = []
    private var stopped: [String] = []
    private var started: [String] = []
    private var unlocked = true
    private var delivery: CarDelivery = .delivered
    private var failure: Error?
    private var list: [CarChat] = CarSessionTests.drive()

    private func session() -> CarSession {
        let s = CarSession(actions: CarActions(
            send: { [unowned self] id, text in
                if let failure { throw failure }
                sent.append((id, text)); return delivery
            },
            newChat: { [unowned self] text in started.append(text); return delivery },
            answer: { [unowned self] id, call, allow in answered.append((id, call, allow)) },
            stop: { [unowned self] id in stopped.append(id) },
            unlocked: { [unowned self] in unlocked },
            computerName: { "Studio Mac" }
        ), now: { [unowned self] in clock })
        s.chats = { [unowned self] in list }
        return s
    }

    private static func drive() -> [CarChat] {
        [
            CarChat(id: "b", title: "Billing retries", state: .needsYou, step: "Allow: run npm test", callId: "call-1", severity: "low",
                    computerId: "mac", computerName: "Studio Mac", reply: "Want me to run the tests first?"),
            CarChat(id: "a", title: "Fix flaky login test", state: .working, step: "Editing auth.spec.ts",
                    computerId: "mac", computerName: "Studio Mac", reply: "On it."),
            CarChat(id: "r", title: "Release notes", state: .working, computerId: "cloud", computerName: "Cloud M1", actionable: false),
        ]
    }

    func testStatusNamesWhatNeedsYou() async {
        let s = session()
        let reply = await s.handle("what's happening")
        XCTAssertEqual(reply.speech, "One chat needs you: Billing retries, to allow run npm test. Two chats are working: Fix flaky login test, Release notes.")
        XCTAssertEqual(reply.next, .end)
        XCTAssertEqual(s.results.first?.title, "Status")
        XCTAssertEqual(s.results.first?.detail, "1 needs you, 2 working")
    }

    func testAllQuiet() {
        XCTAssertEqual(CarSession.statusSpeech([]), "All quiet. Nothing is running.")
    }

    func testTellIsReadBackThenSentOnYes() async {
        let s = session()
        let first = await s.handle("tell the login chat to run the e2e suite")
        XCTAssertTrue(first.confirming)
        XCTAssertEqual(first.next, .listen)
        XCTAssertEqual(first.speech, "Send to Fix flaky login test: run the e2e suite. Say yes to send.")
        XCTAssertEqual(s.confirming, .send)
        XCTAssertTrue(sent.isEmpty, "nothing is sent before yes")
        let second = await s.handle("yes")
        XCTAssertEqual(second.speech, "Sent to Fix flaky login test.")
        XCTAssertEqual(sent.map(\.0), ["a"])
        XCTAssertEqual(sent.map(\.1), ["run the e2e suite"])
        XCTAssertNil(s.confirming)
        XCTAssertEqual(s.results.first?.title, "Sent to Fix flaky login test")
        XCTAssertEqual(s.results.first?.outcome, .done)
    }

    func testNoCancelsTheReadBack() async {
        let s = session()
        _ = await s.handle("tell billing to wait")
        let reply = await s.handle("no")
        XCTAssertEqual(reply.speech, "OK, nothing changed.")
        XCTAssertTrue(sent.isEmpty)
        // A late yes does nothing.
        _ = await s.handle("yes")
        XCTAssertTrue(sent.isEmpty)
    }

    func testReadBackExpires() async {
        let s = session()
        _ = await s.handle("tell billing to wait")
        clock += CarSession.confirmSeconds + 1
        let reply = await s.handle("yes")
        XCTAssertEqual(reply.speech, "That timed out, so nothing changed.")
        XCTAssertTrue(sent.isEmpty)
    }

    func testAnotherCommandDropsTheReadBack() async {
        let s = session()
        _ = await s.handle("tell billing to wait")
        let reply = await s.handle("status")
        XCTAssertTrue(reply.speech.hasPrefix("Nothing changed. "))
        _ = await s.handle("yes")
        XCTAssertTrue(sent.isEmpty)
    }

    func testQueuedSendSaysSoAndUpdatesWhenTheChatRuns() async {
        delivery = .queued
        let s = session()
        _ = await s.handle("tell billing to wait")
        let reply = await s.handle("yes")
        XCTAssertEqual(reply.speech, "Saved. It sends when Studio Mac is back.")
        XCTAssertEqual(s.results.first?.outcome, .waiting)
        XCTAssertEqual(s.results.first?.detail, "Waiting to send · Studio Mac is offline")
        list[0].state = .working
        s.refresh()
        XCTAssertEqual(s.results.first?.outcome, .done)
        XCTAssertEqual(s.results.first?.detail, "Delivered")
        list[0].state = .done
        list[0].reply = "Tests pass."
        s.refresh()
        XCTAssertEqual(s.results.first?.detail, "Reply ready · tap to hear")
        let id = s.results[0].id
        XCTAssertEqual(s.speech(for: id), "Billing retries said: Tests pass.")
    }

    func testFailureIsLoggedWithoutRawErrors() async {
        failure = URLError(.notConnectedToInternet)
        let s = session()
        _ = await s.handle("tell billing to wait")
        let reply = await s.handle("yes")
        XCTAssertEqual(reply.speech, "That didn't work. Couldn't reach the computer.")
        XCTAssertEqual(s.results.first?.outcome, .failed)
        XCTAssertEqual(s.results.first?.title, "Send to Billing retries")
    }

    func testAllowWithOneWaitingNeedsNoName() async {
        let s = session()
        let first = await s.handle("allow")
        XCTAssertEqual(first.speech, "Allow run npm test in Billing retries? Say yes to allow it.")
        _ = await s.handle("yes")
        XCTAssertEqual(answered.map(\.0), ["b"])
        XCTAssertEqual(answered.map(\.1), ["call-1"])
        XCTAssertEqual(answered.map(\.2), [true])
        XCTAssertEqual(s.results.first?.title, "Allowed run npm test")
    }

    func testAllowNeedsAnUnlockedPhoneButDenyDoesNot() async {
        unlocked = false
        let s = session()
        let allow = await s.handle("allow billing")
        XCTAssertEqual(allow.speech, "Allowing a tool needs your iPhone unlocked. It will keep waiting for you.")
        XCTAssertFalse(allow.confirming)
        XCTAssertEqual(s.results.first?.outcome, .failed)
        _ = await s.handle("deny billing")
        _ = await s.handle("yes")
        XCTAssertEqual(answered.map(\.2), [false])
    }

    func testPhoneLockedBetweenReadBackAndYesStillRefusesAllow() async {
        let s = session()
        _ = await s.handle("allow billing")
        unlocked = false
        _ = await s.handle("yes")
        XCTAssertTrue(answered.isEmpty)
    }

    func testHighRiskIsNeverAllowedFromTheCar() async {
        list[0].severity = "high"
        let s = session()
        let reply = await s.handle("allow")
        XCTAssertEqual(reply.speech, "That step is high risk, so it can't be allowed from the car. It will wait for you.")
        _ = await s.handle("yes")
        XCTAssertTrue(answered.isEmpty)
    }

    func testAStaleApprovalIsNotAnswered() async {
        let s = session()
        _ = await s.handle("allow")
        list[0].callId = "call-2"
        let reply = await s.handle("yes")
        XCTAssertEqual(reply.speech, "Billing retries isn't waiting on that any more, so nothing changed.")
        XCTAssertTrue(answered.isEmpty)
    }

    func testAQuestionIsNotAnApproval() async {
        list[0].callId = nil
        let s = session()
        let reply = await s.handle("allow billing")
        XCTAssertEqual(reply.speech, "Billing retries is asking a question, not for an approval. It will wait for you.")
    }

    func testStopIsReadBack() async {
        let s = session()
        let first = await s.handle("stop the login chat")
        XCTAssertEqual(first.speech, "Stop Fix flaky login test? Its work so far stays in the chat. Say yes to stop it.")
        _ = await s.handle("yeah")
        XCTAssertEqual(stopped, ["a"])
    }

    func testAnotherComputersChatIsNotActedOn() async {
        let s = session()
        let reply = await s.handle("stop release notes")
        XCTAssertEqual(reply.speech, "Release notes is on Cloud M1. From the car I can act on chats on your active computer.")
        XCTAssertFalse(reply.confirming)
    }

    func testAmbiguousNameAsksWhichAndTakesAPick() async {
        list.append(CarChat(id: "d", title: "Billing dashboard", state: .working, computerId: "mac", computerName: "Studio Mac"))
        let s = session()
        let first = await s.handle("tell billing to pause")
        XCTAssertEqual(first.speech, "Which one? first, Billing retries; second, Billing dashboard.")
        XCTAssertEqual(first.next, .listen)
        let second = await s.handle("the second one")
        XCTAssertEqual(second.speech, "Send to Billing dashboard: pause. Say yes to send.")
        _ = await s.handle("yes")
        XCTAssertEqual(sent.map(\.0), ["d"])
    }

    func testAmbiguousNameTakesANameToo() async {
        list.append(CarChat(id: "d", title: "Billing dashboard", state: .working, computerId: "mac", computerName: "Studio Mac"))
        let s = session()
        _ = await s.handle("read billing")
        let reply = await s.handle("dashboard")
        XCTAssertEqual(reply.speech, "Billing dashboard hasn't replied yet. It's working.")
    }

    func testReadSpeaksTheReplyAndLogsOnlyTheState() async {
        let s = session()
        let reply = await s.handle("what did billing say")
        XCTAssertEqual(reply.speech, "Billing retries said: Want me to run the tests first?")
        // The Results row is drawn on the car's screen: never the reply's words.
        XCTAssertEqual(s.results.first?.title, "Read Billing retries")
        XCTAssertEqual(s.results.first?.detail, "Needs you")
    }

    func testUnknownChat() async {
        let s = session()
        let reply = await s.handle("tell groceries to buy milk")
        XCTAssertEqual(reply.speech, "I couldn't find a chat called groceries.")
    }

    func testNewChatIsReadBack() async {
        let s = session()
        let first = await s.handle("start a chat to look into the flaky test")
        XCTAssertEqual(first.speech, "Start a new chat on Studio Mac: look into the flaky test. Say yes to start it.")
        _ = await s.handle("yes")
        XCTAssertEqual(started, ["look into the flaky test"])
        XCTAssertEqual(s.results.first?.title, "New chat on Studio Mac")
    }

    func testInsideAChatAMessageGoesStraightInAndWaitsForTheAnswer() async {
        let s = session()
        let reply = await s.handle("Use the staging database", inChat: "a")
        XCTAssertEqual(sent.map(\.1), ["Use the staging database"])
        XCTAssertEqual(reply.next, .awaitReply(chatId: "a"))
        XCTAssertFalse(reply.confirming)
    }

    func testRepeat() async {
        let s = session()
        _ = await s.handle("read billing")
        let reply = await s.handle("say that again")
        XCTAssertEqual(reply.speech, "Billing retries said: Want me to run the tests first?")
    }

    func testResultsAreCapped() async {
        let s = session()
        for _ in 0..<(CarSession.maxResults + 5) { _ = await s.handle("status") }
        XCTAssertEqual(s.results.count, CarSession.maxResults)
    }

    // MARK: The voice loop

    func testLoopReadsBackListensAgainAndEnds() async {
        let s = session()
        var heard = ["tell billing to run the tests", "yes"]
        var spoken: [String] = []
        var phases: [CarVoicePhase] = []
        await s.talk(capture: { heard.removeFirst() }, speak: { spoken.append($0) }, phase: { phases.append($0) },
                     awaitReply: { _, _ in XCTFail("no reply wait outside a chat"); return nil })
        XCTAssertEqual(spoken, ["Send to Billing retries: run the tests. Say yes to send.", "Sent to Billing retries."])
        XCTAssertEqual(phases, [.listening, .working, .confirming, .listening, .working, .speaking, .done])
        XCTAssertEqual(sent.count, 1)
    }

    func testLoopInAChatSpeaksTheAnswerThenListensAgain() async {
        let s = session()
        var heard = ["Use the staging database", ""]
        var spoken: [String] = []
        await s.talk(inChat: "a", capture: { heard.removeFirst() }, speak: { spoken.append($0) }, phase: { _ in },
                     awaitReply: { id, before in
                         XCTAssertEqual(id, "a")
                         XCTAssertEqual(before, "On it.")
                         return "**Done.** Switched to staging."
                     })
        XCTAssertEqual(spoken, ["Sent to Fix flaky login test.", "Done. Switched to staging.", "OK, nothing changed."])
    }

    func testLoopSaysWhenTheReplyIsSlow() async {
        let s = session()
        var heard = ["Use the staging database"]
        var spoken: [String] = []
        await s.talk(inChat: "a", capture: { heard.removeFirst() }, speak: { spoken.append($0) }, phase: { _ in },
                     awaitReply: { _, _ in nil })
        XCTAssertEqual(spoken.last, "It's still working. I'll put its reply in Results.")
    }

    func testSilenceEndsWithoutSending() async {
        let s = session()
        var spoken: [String] = []
        await s.talk(capture: { "" }, speak: { spoken.append($0) }, phase: { _ in }, awaitReply: { _, _ in nil })
        XCTAssertEqual(spoken, ["I didn't hear anything."])
    }

    func testCancelDuringReadBackSendsNothingLater() async {
        let s = session()
        var heard = ["tell billing to run the tests"]
        await s.talk(capture: {
            if heard.isEmpty { throw CancellationError() }
            return heard.removeFirst()
        }, speak: { _ in }, phase: { _ in }, awaitReply: { _, _ in nil })
        XCTAssertNil(s.confirming)
        _ = await s.handle("yes")
        XCTAssertTrue(sent.isEmpty)
    }

    func testAConversationIsBounded() async {
        let s = session()
        var captures = 0
        await s.talk(inChat: "a", capture: { captures += 1; return "keep going" }, speak: { _ in }, phase: { _ in },
                     awaitReply: { _, _ in "ok" })
        XCTAssertEqual(captures, CarSession.maxTurns)
    }

    func testATapActsWithoutAReadBack() async {
        let s = session()
        let reply = await s.act(.allow(chat: nil), on: "b")
        XCTAssertEqual(reply.speech, "Allowed run npm test.")
        XCTAssertEqual(answered.map(\.2), [true])
        XCTAssertNil(s.confirming)
    }

    func testATapStillFollowsTheRules() async {
        unlocked = false
        let s = session()
        let reply = await s.act(.allow(chat: nil), on: "b")
        XCTAssertEqual(reply.speech, "Allowing a tool needs your iPhone unlocked. It will keep waiting for you.")
        XCTAssertTrue(answered.isEmpty)
        _ = await s.act(.stop(chat: nil), on: "r")
        XCTAssertTrue(stopped.isEmpty, "another computer's chat")
        _ = await s.act(.stop(chat: nil), on: "a")
        XCTAssertEqual(stopped, ["a"])
    }

    func testStartDriveClearsResults() async {
        let s = session()
        _ = await s.handle("status")
        s.startDrive()
        XCTAssertTrue(s.results.isEmpty)
    }
}
