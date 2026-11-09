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

    func testRowTitleIsOneLineAndBlankAtMinimal() throws {
        var a = chat("a", .working)
        a.title = "Fix the  login\nredirect " + String(repeating: "x", count: 60)
        let standard = try XCTUnwrap(build([a], level: .standard)).chats[0]
        XCTAssertEqual(standard.title.count, LiveCardRules.titleLength)
        XCTAssertTrue(standard.title.hasPrefix("Fix the login redirect x"))
        XCTAssertTrue(standard.title.hasSuffix("…"))
        XCTAssertEqual(try XCTUnwrap(build([a], level: .minimal)).chats[0].title, "")
    }

    /// An empty title is left out, so cards from before the rows keep their size;
    /// one that is there round-trips.
    func testEncodesTheTitleOnlyWhenThere() throws {
        let plain = try XCTUnwrap(build([chat("a", .working)]))
        XCTAssertFalse(String(decoding: try JSONEncoder().encode(plain), as: UTF8.self).contains("\"title\""))
        var titled = chat("a", .working)
        titled.title = "Fix login"
        let card = try XCTUnwrap(build([titled]))
        XCTAssertEqual(try JSONDecoder().decode(LiveCardState.self, from: JSONEncoder().encode(card)).chats[0].title, "Fix login")
    }

    func testChipsAreTheFirstFiveWithTheFocusSwappedIn() throws {
        let chats = [chat("n", .needsYou), chat("r1", .working), chat("r2", .working), chat("r3", .working),
                     chat("w", .watching), chat("d1", .done, finished: 60), chat("d2", .done, finished: 90)]
        let card = try XCTUnwrap(build(chats))
        let all = cardChips(card)
        XCTAssertEqual(all.chips.map(\.id), ["n", "r1", "r2", "r3", "w"], "what needs you comes first")
        XCTAssertEqual(all.more, 2)
        // A chat focused further down takes the last chip, so the detail line and the mic belong to a chip you can see.
        XCTAssertEqual(cardChips(try XCTUnwrap(build(chats, pinned: "d2"))).chips.map(\.id), ["n", "r1", "r2", "r3", "d2"])
        let one = cardChips(try XCTUnwrap(build([chat("only", .working)])))
        XCTAssertEqual(one.chips.map(\.id), ["only"])
        XCTAssertEqual(one.more, 0)
        // Past the eight the state carries, the rest are counted in the same "+N".
        let many = cardChips(try XCTUnwrap(build((0..<11).map { chat("c\($0)", .working) })))
        XCTAssertEqual(many.chips.count, 5)
        XCTAssertEqual(many.more, 6)
        // Fewer chips when five do not fit: the focus still has one, the rest join "+N".
        let two = cardChips(try XCTUnwrap(build(chats, pinned: "d2")), limit: 2)
        XCTAssertEqual(two.chips.map(\.id), ["n", "d2"])
        XCTAssertEqual(two.more, 5)
        XCTAssertEqual(cardChips(card, limit: 0).chips.map(\.id), ["n"], "never no chip")
        XCTAssertEqual(cardChips(card, limit: 9).chips.count, 5, "never more than five")
    }

    /// One card: the app's own stays and every other ends; with none of its own,
    /// the last listed is kept (and carried on with); duplicates in the list are one card.
    func testConsolidateKeepsOneCard() {
        XCTAssertEqual(consolidateCards(live: [], current: nil).keep, nil)
        XCTAssertEqual(consolidateCards(live: [], current: "gone").end, [])
        let mine = consolidateCards(live: ["old", "mine", "pushed"], current: "mine")
        XCTAssertEqual(mine.keep, "mine")
        XCTAssertEqual(mine.end, ["old", "pushed"])
        let none = consolidateCards(live: ["old", "pushed"], current: nil)
        XCTAssertEqual(none.keep, "pushed", "the last listed")
        XCTAssertEqual(none.end, ["old"])
        let unlisted = consolidateCards(live: ["old", "pushed"], current: "mine")
        XCTAssertEqual(unlisted.keep, "mine", "the app's own card stays before iOS lists it")
        XCTAssertEqual(unlisted.end, ["old", "pushed"])
        let twice = consolidateCards(live: ["a", "a", "b"], current: "a")
        XCTAssertEqual(twice.keep, "a")
        XCTAssertEqual(twice.end, ["b"])
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

    /// "Always allow" on the card: only when set, so other cards keep their size,
    /// and a push without it decodes as off.
    func testEncodesAlwaysAllowOnlyWhenSet() throws {
        var c = chat("n", .needsYou)
        c.callId = "call_7"
        let off = try JSONSerialization.jsonObject(with: JSONEncoder().encode(c)) as? [String: Any]
        XCTAssertNil(off?["alwaysAllow"])
        c.alwaysAllow = true
        let data = try JSONEncoder().encode(c)
        let on = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertEqual(on?["alwaysAllow"] as? Bool, true)
        XCTAssertEqual(try JSONDecoder().decode(LiveChat.self, from: data), c)
        let pushed = try JSONDecoder().decode(LiveChat.self, from: Data(#"{"id":"n","state":"needsYou","callId":"c"}"#.utf8))
        XCTAssertFalse(pushed.alwaysAllow)
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
    /// The shared rules (packages/shared/fixtures/live-card.json), which the
    /// computer's Rust port (crates/nekko-remote card.rs) runs too. Everything
    /// decodes with a plain JSONDecoder, as ActivityKit decodes a pushed state.
    func testSharedFixture() throws {
        let file = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("packages/shared/fixtures/live-card.json")
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        func decode<T: Decodable>(_ type: T.Type, _ v: Any) throws -> T {
            try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: v, options: .fragmentsAllowed))
        }
        let now = Date(timeIntervalSinceReferenceDate: try XCTUnwrap(root["now"] as? Double))
        let builds = try XCTUnwrap(root["build"] as? [[String: Any]])
        XCTAssertGreaterThanOrEqual(builds.count, 20)
        for c in builds {
            let name = c["name"] as? String ?? ""
            let chats = try decode([LiveChat].self, c["chats"] ?? [])
            let previous = try c["previous"].map { try decode(LiveCardState.self, $0) }
            let level = try XCTUnwrap(LiveLevel(rawValue: c["level"] as? String ?? ""), name)
            let card = buildCard(chats: chats, previous: previous, pinnedFocus: c["pinnedFocus"] as? String, level: level, now: now)
            let want = try (c["card"].flatMap { $0 is NSNull ? nil : $0 }).map { try decode(LiveCardState.self, $0) }
            XCTAssertEqual(card, want, name)
            if let card { XCTAssertEqual(try JSONEncoder().encode(card).count, c["bytes"] as? Int, "bytes: \(name)") }
        }
        for c in try XCTUnwrap(root["decode"] as? [[String: Any]]) {
            let name = c["name"] as? String ?? ""
            let state = try decode(LiveCardState.self, c["json"] ?? [:])
            XCTAssertEqual(state.chats.map(\.state.rawValue), c["states"] as? [String], name)
            XCTAssertEqual(state.counts, c["counts"] as? [String: Int], "counts: \(name)")
            XCTAssertEqual(try decode(LiveCardState.self, JSONSerialization.jsonObject(with: JSONEncoder().encode(state))), state, "round trip: \(name)")
            if let at = c["finishedAt"] as? Double { XCTAssertEqual(state.chats[0].finishedAt, Date(timeIntervalSinceReferenceDate: at), name) }
            if let at = c["startedAt"] as? Double { XCTAssertEqual(state.chats[0].startedAt, Date(timeIntervalSinceReferenceDate: at), name) }
        }
        for c in try XCTUnwrap(root["shortTitle"] as? [[String]]) { XCTAssertEqual(shortTitle(c[0]), c[1], c[0]) }
        for c in try XCTUnwrap(root["closeWord"] as? [[Any]]) {
            XCTAssertEqual(closeWord(for: c[0] as? String ?? "?", failed: c[1] as? Bool ?? false), c[2] as? String, "\(c[0])")
        }
        for c in try XCTUnwrap(root["replyLine"] as? [[String]]) { XCTAssertEqual(replyLine(c[0]), c[1], c[0]) }
    }

    func testPhoneOnlyFieldsStayOffTheWireUntilSetAndRoundTrip() throws {
        let plain = LiveCardState(chats: [], focusId: nil, more: 0, listening: false, heard: "", counts: ["working": 1])
        let json = String(decoding: try JSONEncoder().encode(plain), as: UTF8.self)
        XCTAssertFalse(json.contains("scope"), "a computer's fixture bytes are unchanged")
        XCTAssertFalse(json.contains("listeningSince"))
        var local = plain
        local.scope = "All computers"
        local.listening = true
        local.listeningSince = Date(timeIntervalSinceReferenceDate: 1000)
        XCTAssertEqual(try JSONDecoder().decode(LiveCardState.self, from: JSONEncoder().encode(local)), local)
        let pushed = try JSONDecoder().decode(LiveCardState.self, from: Data(#"{"chats":[],"counts":{"done":2}}"#.utf8))
        XCTAssertNil(pushed.scope)
        XCTAssertNil(pushed.listeningSince)
    }

    func testScopeLabelFollowsWhatTheChatListShows() {
        XCTAssertNil(cardScope(computerName: "Mac", computers: 1, phoneChats: false))
        XCTAssertEqual(cardScope(computerName: "Mac", computers: 1, phoneChats: true), "Mac + iPhone")
        XCTAssertEqual(cardScope(computerName: "Mac", computers: 3, phoneChats: false), "All computers")
        XCTAssertEqual(cardScope(computerName: "Mac", computers: 2, phoneChats: true), "All computers")
    }

    func testCapturingPhasesOfferCancelAndFinish() {
        var s = LiveCardState(chats: [], focusId: nil, more: 0, listening: true, heard: LiveCardVoice.listening)
        XCTAssertTrue(LiveCardVoice.capturing(s))
        s.heard = LiveCardVoice.hearing
        XCTAssertTrue(LiveCardVoice.capturing(s))
        for later in [LiveCardVoice.processing, LiveCardVoice.sending] {
            s.heard = later
            XCTAssertFalse(LiveCardVoice.capturing(s), later)
        }
        s.listening = false
        s.heard = LiveCardVoice.listening
        XCTAssertFalse(LiveCardVoice.capturing(s))
    }
}
