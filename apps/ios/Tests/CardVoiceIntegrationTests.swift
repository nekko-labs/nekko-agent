import XCTest
import NekkoKit
import NekkoProtocol
@testable import NekkoNative

@MainActor
final class CardVoiceIntegrationTests: XCTestCase {
    private func outbox() -> Outbox {
        let drafts = DraftStore(files: nil, debounce: 0)
        drafts.load("pc")
        let box = Outbox(files: nil, drafts: drafts, caller: { nil })
        box.load("pc")
        return box
    }

    func testCancelDuringOnlinePreparationNeverPersistsAndKeepsProcessingAlive() async {
        let box = outbox()
        let runner = NekkoVoiceRunner()
        var resume: CheckedContinuation<Bool, Never>?
        var shown: [(Bool, String)] = []
        runner.capture = { "confirmed command" }
        runner.show = { shown.append(($0, $1)) }
        runner.routeWithCommit = { _, permit in
            _ = try await CardVoiceDelivery.send(outbox: box, sessionId: "chat", text: "hello", permit: permit,
                waitOnline: { await withCheckedContinuation { resume = $0 } }, allowed: { true })
            return "Queued"
        }
        let task = Task { await runner.talk() }
        while resume == nil { await Task.yield() }
        XCTAssertTrue(shown.last?.0 == true)
        XCTAssertEqual(shown.last?.1, "Processing…")
        XCTAssertTrue(runner.canCancel)
        runner.cancel()
        resume?.resume(returning: false)
        await task.value
        XCTAssertTrue(box.items.isEmpty)
        XCTAssertEqual(shown.last?.1, "Cancelled. Nothing sent.")
    }

    func testDenialArchivalRenameAndScopeChangeDuringPreparationRejectAtCommit() async {
        for change in ["denied", "archived", "renamed", "computer changed", "card changed"] {
            let box = outbox()
            let runner = NekkoVoiceRunner()
            var activeId = "pc"
            var cardId = "pc"
            var state = RelayState.online
            var target = NekkoVoiceDispatcher.Target(id: "chat", name: "Login")
            runner.capture = { "confirmed command" }
            runner.routeWithCommit = { _, permit in
                _ = try await CardVoiceDelivery.send(outbox: box, sessionId: "chat", text: "hello", permit: permit,
                    waitOnline: {
                        switch change {
                        case "denied": state = .denied
                        case "archived": target.archived = true
                        case "renamed": target.name = "Other"
                        case "computer changed": activeId = "other"
                        default: cardId = "other"
                        }
                        await Task.yield()
                        return false
                    }, allowed: {
                        NekkoVoiceScope.permitsDelivery(computerId: "pc", activeId: activeId,
                            cardComputerId: cardId, state: state, targets: [target],
                            sessionId: "chat", confirmedName: "Login")
                    })
                return "Queued"
            }
            await runner.talk()
            XCTAssertTrue(box.items.isEmpty, change)
        }
    }

    func testDiscardInvalidatesQueuedAudioAndLateTranscription() async {
        let dictation = Dictation()
        var resume: CheckedContinuation<String?, Never>?
        var calls = 0
        dictation.transcribe = { _ in
            calls += 1
            return await withCheckedContinuation { resume = $0 }
        }
        dictation.enqueue([0.1, 0.2])
        while resume == nil { await Task.yield() }
        dictation.enqueue([0.3, 0.4])
        dictation.discard()
        resume?.resume(returning: "late private words")
        await dictation.drain()
        XCTAssertEqual(calls, 1, "Queued old audio must not transcribe under a later capture")
        XCTAssertTrue(dictation.heard.isEmpty)
    }

    func testExplicitDenialRejectsBeforeConnectionPreparation() async {
        let box = outbox()
        let runner = NekkoVoiceRunner()
        var waits = 0
        runner.capture = { "confirmed command" }
        runner.routeWithCommit = { _, permit in
            _ = try await CardVoiceDelivery.send(outbox: box, sessionId: "chat", text: "hello", permit: permit,
                waitOnline: { waits += 1; return false }, allowed: {
                    NekkoVoiceScope.permits(computerId: "pc", activeId: "pc", state: .denied)
                })
            return "Queued"
        }
        await runner.talk()
        XCTAssertEqual(waits, 0)
        XCTAssertTrue(box.items.isEmpty)
    }

    func testOfflineQueuesAndCancelAfterPersistenceCannotRecall() async {
        let box = outbox()
        let runner = NekkoVoiceRunner()
        var resume: CheckedContinuation<Void, Never>?
        var shown = ""
        runner.capture = { "confirmed command" }
        runner.show = { _, text in shown = text }
        runner.routeWithCommit = { _, permit in
            let delivered = try await CardVoiceDelivery.send(outbox: box, sessionId: "chat", text: "hello", permit: permit,
                waitOnline: { false }, allowed: { true })
            XCTAssertFalse(delivered)
            await withCheckedContinuation { resume = $0 }
            return "Queued, not sent yet."
        }
        let task = Task { await runner.talk() }
        while resume == nil { await Task.yield() }
        XCTAssertEqual(box.items.count, 1)
        XCTAssertFalse(runner.canCancel)
        runner.cancel()
        XCTAssertEqual(shown, "Processing…")
        resume?.resume()
        await task.value
        XCTAssertEqual(box.items.first?.text, "hello")
        XCTAssertEqual(shown, "Queued, not sent yet.")
    }
}
