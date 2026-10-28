import Foundation
import XCTest
@testable import NekkoProtocol

final class LiveCardTests: XCTestCase {
    let now = Date(timeIntervalSince1970: 100_000)

    func chat(_ id: String, _ state: LiveChatState, finished: TimeInterval? = nil, short: String = "T", step: String = "S", reply: String = "R") -> LiveChat {
        LiveChat(id: id, short: short, state: state, step: step, reply: reply, closeWord: "Cool",
                 finishedAt: finished.map { now.addingTimeInterval(-$0) }, callId: nil, severity: nil)
    }

    func build(_ chats: [LiveChat], previous: LiveCardState? = nil, pinned: String? = nil, level: LiveLevel = .detailed) -> LiveCardState? {
        buildCard(chats: chats, previous: previous, pinnedFocus: pinned, level: level, now: now)
    }

    func testSortsByStateThenMostRecent() {
        let card = build([
            chat("f", .failed, finished: 60), chat("d-old", .done, finished: 600), chat("d-new", .done, finished: 60),
            chat("w", .watching), chat("r", .working), chat("n", .needsYou),
        ])!
        XCTAssertEqual(card.chats.map(\.id), ["n", "r", "w", "d-new", "d-old", "f"])
        XCTAssertEqual(card.focusId, "n")
    }

    /// ActivityKit drops a content state over 4 KB, even for a local request or update.
    func testStaysUnderTheSizeLimitAndKeepsTheFocusedChat() throws {
        let long = String(repeating: "日本語のとても長いチャットのタイトル", count: 20)
        let chats = (0..<8).map { i in
            chat("chat-\(i)-" + UUID().uuidString, .working, short: long, step: long, reply: long)
        }
        let focused = chats[7].id
        let card = try XCTUnwrap(build(chats, pinned: focused))
        XCTAssertLessThanOrEqual(try JSONEncoder().encode(card).count, 3500)
        XCTAssertEqual(card.focusId, focused)
        XCTAssertTrue(card.chats.contains { $0.id == focused }, "the focused chat is never dropped")
        XCTAssertEqual(card.chats.count + card.more, 8)
        XCTAssertTrue(card.chats.allSatisfy { $0.step.count <= 60 })
    }

    func testClipsTheStepAndKeepsRepliesWhenSmall() throws {
        let card = try XCTUnwrap(build([chat("a", .working, step: String(repeating: "x", count: 200), reply: "Done.")]))
        XCTAssertEqual(card.chats[0].step.count, 60)
        XCTAssertEqual(card.chats[0].reply, "Done.", "a small card keeps its reply line")
    }

    func testKeepsEightAndCountsTheRest() {
        let card = build((0..<10).map { chat("c\($0)", .working) })!
        XCTAssertEqual(card.chats.count, 8)
        XCTAssertEqual(card.more, 2)
    }

    func testDropsOldFinishedChats() {
        let card = build([chat("old", .done, finished: 2 * 3600 + 60), chat("older", .failed, finished: 5 * 3600), chat("ok", .done, finished: 2 * 3600 - 60)])!
        XCTAssertEqual(card.chats.map(\.id), ["ok"])
        XCTAssertEqual(card.more, 0)
    }

    func testNilWhenNothingLeftOrLevelNone() {
        XCTAssertNil(build([]))
        XCTAssertNil(build([chat("old", .done, finished: 3 * 3600)]))
        XCTAssertNil(build([chat("a", .working)], level: .none))
    }

    func testFocusDefaultsToFirstAndKeepsPin() {
        let chats = [chat("a", .working), chat("b", .working), chat("c", .watching)]
        XCTAssertEqual(build(chats)!.focusId, "a")
        XCTAssertEqual(build(chats, pinned: "c")!.focusId, "c")
        XCTAssertEqual(build(chats, pinned: "gone")!.focusId, "a")
    }

    func testFocusJumpsToNewlyNeedsYouOverPin() {
        let before = build([chat("a", .working), chat("b", .working)], pinned: "b")!
        let after = build([chat("a", .working), chat("b", .needsYou)], previous: before, pinned: "a")!
        XCTAssertEqual(after.focusId, "b")
        // Already needed you last time: not new, so the pin wins.
        let again = build([chat("a", .working), chat("b", .needsYou)], previous: after, pinned: "a")!
        XCTAssertEqual(again.focusId, "a")
    }

    func testBrandNewNeedsYouChatIsNewlyEntered() {
        let before = build([chat("a", .working)])!
        let after = build([chat("a", .working), chat("z", .needsYou)], previous: before, pinned: "a")!
        XCTAssertEqual(after.focusId, "z")
    }

    func testLevelsBlankText() {
        let chats = [chat("a", .working, short: "Fix", step: "Run tests", reply: "Got it")]
        let minimal = build(chats, level: .minimal)!.chats[0]
        XCTAssertEqual([minimal.short, minimal.step, minimal.reply], ["", "", ""])
        XCTAssertEqual(minimal.closeWord, "Cool")
        let standard = build(chats, level: .standard)!.chats[0]
        XCTAssertEqual([standard.short, standard.step, standard.reply], ["Fix", "Run tests", ""])
        let detailed = build(chats, level: .detailed)!.chats[0]
        XCTAssertEqual(detailed.reply, "Got it")
    }

    func testShortTitle() {
        XCTAssertEqual(shortTitle("Fix login bug"), "Fix")
        XCTAssertEqual(shortTitle("Fix it now"), "Fix it")
        XCTAssertEqual(shortTitle("Refactoring the parser"), "Refactor…")
        XCTAssertEqual(shortTitle("  Deploy  "), "Deploy")
        XCTAssertEqual(shortTitle("Exactly8 words"), "Exactly8")
        XCTAssertEqual(shortTitle(""), "")
    }

    func testCloseWord() {
        let words: Set<String> = ["Looks good", "Cool", "Excellent", "Nice", "Perfect"]
        XCTAssertEqual(closeWord(for: "chat-1", failed: true), "Got it")
        XCTAssertEqual(closeWord(for: "chat-1", failed: false), closeWord(for: "chat-1", failed: false))
        // FNV-1a("chat-1") is fixed, so the pick is the same in every process.
        XCTAssertEqual(closeWord(for: "chat-1", failed: false), "Excellent")
        let picked = Set((0..<60).map { closeWord(for: "id\($0)", failed: false) })
        XCTAssertTrue(picked.isSubset(of: words))
        XCTAssertGreaterThan(picked.count, 1)
    }

    func testDecodesMissingFieldsAndRoundTrips() throws {
        let empty = try JSONDecoder().decode(LiveCardState.self, from: Data("{}".utf8))
        XCTAssertEqual(empty, LiveCardState(chats: [], focusId: nil, more: 0, listening: false, heard: ""))
        let decoded = try JSONDecoder().decode(LiveChat.self, from: Data(#"{"id":"a","state":"working"}"#.utf8))
        XCTAssertEqual(decoded.id, "a")
        XCTAssertEqual(decoded.step, "")
        XCTAssertNil(decoded.finishedAt)
        XCTAssertNil(decoded.startedAt)
        var running = chat("b", .working)
        running.startedAt = now.addingTimeInterval(-90)
        let state = build([chat("a", .done, finished: 10), running])!
        XCTAssertEqual(state.chats.first { $0.id == "b" }?.startedAt, running.startedAt)
        let data = try JSONEncoder().encode(state)
        XCTAssertEqual(try JSONDecoder().decode(LiveCardState.self, from: data), state)
    }

    func testDuplicateIdsInPreviousDoNotTrap() {
        let previous = LiveCardState(chats: [chat("a", .working), chat("a", .needsYou)], focusId: "a", more: 0, listening: false, heard: "")
        let card = build([chat("a", .needsYou)], previous: previous)
        XCTAssertEqual(card?.chats.map(\.id), ["a"])
    }

    func testUnknownStateDecodesAsWorking() throws {
        let decoded = try JSONDecoder().decode(LiveCardState.self, from: Data(#"{"chats":[{"id":"a","state":"sleeping"},{"id":"b","state":"done"}]}"#.utf8))
        XCTAssertEqual(decoded.chats.map(\.state), [.working, .done])
    }

    func testReplyLineIsTheFirstSentenceUpTo60Characters() {
        XCTAssertEqual(replyLine("Got it. Working on it now."), "Got it.")
        XCTAssertEqual(replyLine("  Done!\nThe tests pass."), "Done!")
        XCTAssertEqual(replyLine("Line one\nline two"), "Line one")
        XCTAssertEqual(replyLine("Version 1.2 is out"), "Version 1.2 is out", "a dot inside a word ends nothing")
        XCTAssertEqual(replyLine(nil), "")
        let long = replyLine(String(repeating: "word ", count: 30))
        XCTAssertEqual(long.count, 60)
        XCTAssertTrue(long.hasSuffix("…"))
    }
}
