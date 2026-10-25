import Foundation
import XCTest
@testable import NekkoKit

/// The folding-phone panes (FD-3, FD-4, FD-6): arrangements, Swap / Focus /
/// Replace with…, where an opened chat lands, the vertical-mode rules, the
/// one-time tip, the hinge split and the tabletop flex layout.
final class PanesTests: XCTestCase {
    private func layout(_ a: PaneContent, _ b: PaneContent, focus: String = PaneLayout.secondId, split: Double = 0.5) -> PaneLayout {
        PaneLayout(panes: [Pane(id: "a", content: a), Pane(id: "b", content: b)], split: split, focusedId: focus)
    }

    func testTheFirstOpenIsTheChatListBesideAChatPane() {
        let l = PaneLayout.standard
        XCTAssertEqual(l.arrangement, .chatsChat)
        XCTAssertEqual(l.first.content, .chats)
        XCTAssertEqual(l.second.content, .empty)
        XCTAssertEqual(l.focusedId, l.second.id, "the chat pane has the keyboard")
        XCTAssertNil(l.maximizedId)
    }

    func testNamesTheFourArrangements() {
        XCTAssertEqual(layout(.chat("x"), .chat("y")).arrangement, .chatChat)
        XCTAssertEqual(layout(.chat("x"), .monitors).arrangement, .chatMonitors)
        XCTAssertEqual(layout(.chats, .chat("x")).arrangement, .chatsChat)
        XCTAssertEqual(layout(.chats, .newChat).arrangement, .chatsChat)
        XCTAssertEqual(layout(.monitors, .chats).arrangement, .monitorsChats)
        XCTAssertNil(layout(.monitors, .monitors).arrangement)
        XCTAssertNil(layout(.chats, .chats).arrangement)
    }

    func testTheDividerStaysBetween35And65() {
        var l = layout(.chat("x"), .chat("y"))
        l.setSplit(0.1)
        XCTAssertEqual(l.split, 0.35)
        l.setSplit(0.9)
        XCTAssertEqual(l.split, 0.65)
        l.setSplit(.nan)
        XCTAssertEqual(l.split, 0.5)
        l.setSplit(0.42)
        XCTAssertEqual(l.split, 0.42)
    }

    func testSwapTradesPlacesAndEachPaneKeepsItsSize() {
        var l = layout(.chats, .chat("x"), split: 0.4)
        l.swap()
        XCTAssertEqual(l.panes.map(\.id), ["b", "a"], "the panes move, so their views (and scroll positions) move with them")
        XCTAssertEqual(l.first.content, .chat("x"))
        XCTAssertEqual(l.split, 0.6, accuracy: 1e-9)
        XCTAssertEqual(l.focusedId, "b")
    }

    func testFocusFillsTheScreenAndAgainBringsBothBack() {
        var l = layout(.chat("x"), .chat("y"))
        l.toggleMaximized("a")
        XCTAssertEqual(l.maximizedId, "a")
        XCTAssertEqual(l.focusedId, "a")
        let shown = l.display(.openWide)
        XCTAssertEqual(shown.mode, .single)
        XCTAssertEqual(shown.shownId, "a")
        l.toggleMaximized("a")
        XCTAssertNil(l.maximizedId)
        XCTAssertEqual(l.display(.openWide).mode, .sideBySide)
    }

    func testReplaceNeverShowsOneChatTwice() {
        var l = layout(.chat("x"), .chat("y"), focus: "a")
        l.replace("a", with: .chat("y"))
        XCTAssertEqual(l.panes.map(\.content), [.chat("y"), .chat("x")], "the panes trade chats")
        XCTAssertEqual(l.focusedId, "a")
        l.replace("b", with: .monitors)
        XCTAssertEqual(l.arrangement, .chatMonitors)
        l.replace("a", with: .empty)
        l.replace("b", with: .empty)
        XCTAssertEqual(l.panes.map(\.content), [.empty, .empty], "two empty chat panes are fine")
    }

    func testAChatFromTheListLandsInTheChatPane() {
        var l = PaneLayout.standard
        l.focus("a") // the list was tapped
        let landed = l.open(.chat("x"), from: "a")
        XCTAssertEqual(landed, "b")
        XCTAssertEqual(l.second.content, .chat("x"))
        XCTAssertEqual(l.focusedId, "b")
        XCTAssertEqual(l.first.content, .chats, "the list stays")
    }

    func testAChatAlreadyOnScreenIsFocusedNotOpenedTwice() {
        var l = layout(.chat("x"), .chat("y"), focus: "b")
        XCTAssertEqual(l.open(.chat("x")), "a")
        XCTAssertEqual(l.panes.map(\.content), [.chat("x"), .chat("y")])
        XCTAssertEqual(l.focusedId, "a")
    }

    func testFromOutsideAChatReplacesTheFocusedChat() {
        var l = layout(.chat("x"), .chat("y"), focus: "b")
        XCTAssertEqual(l.open(.chat("z")), "b")
        XCTAssertEqual(l.panes.map(\.content), [.chat("x"), .chat("z")])
    }

    func testFromMonitorsARunningChatOpensInTheOtherPane() {
        var l = layout(.monitors, .chats, focus: "a")
        XCTAssertEqual(l.open(.chat("x"), from: "a"), "b")
        XCTAssertEqual(l.panes.map(\.content), [.monitors, .chat("x")])
        var m = layout(.chat("x"), .monitors, focus: "b")
        XCTAssertEqual(m.open(.chat("y"), from: "b"), "a")
        XCTAssertEqual(m.panes.map(\.content), [.chat("y"), .monitors])
    }

    func testMonitorsOpensBesideTheFocusedChat() {
        var l = layout(.chats, .chat("x"), focus: "b")
        XCTAssertEqual(l.open(.monitors), "a")
        XCTAssertEqual(l.panes.map(\.content), [.monitors, .chat("x")])
        var fromList = layout(.chats, .chat("x"), focus: "a")
        XCTAssertEqual(fromList.open(.monitors, from: "a"), "a", "Monitors from the list's row takes the list's place, beside the chat")
        XCTAssertEqual(fromList.panes.map(\.content), [.monitors, .chat("x")])
    }

    func testOpeningWhileFocusedMovesFocusToTheNewPane() {
        var l = layout(.chat("x"), .chat("y"))
        l.toggleMaximized("a")
        l.open(.chat("y"))
        XCTAssertEqual(l.maximizedId, "b", "Focus follows the chat that was opened")
    }

    func testArrangementsKeepTheChatOnScreenInItsPane() {
        var l = layout(.chats, .chat("x"), focus: "b")
        l.apply(.chatChat, recent: ["x", "y", "z"])
        XCTAssertEqual(l.arrangement, .chatChat)
        XCTAssertEqual(l.pane("b")?.content, .chat("x"), "x stays in pane b, so its view is kept")
        XCTAssertEqual(l.pane("a")?.content, .chat("y"), "the most recent other chat")
        XCTAssertEqual(l.first.content, .chat("x"), "the chat on screen is the primary one")
        XCTAssertEqual(l.split, 0.5)

        l.apply(.chatMonitors)
        XCTAssertEqual(l.panes.map(\.content), [.chat("x"), .monitors])
        XCTAssertEqual(l.pane("b")?.content, .chat("x"))

        l.apply(.chatsChat)
        XCTAssertEqual(l.panes.map(\.content), [.chats, .chat("x")])
        XCTAssertEqual(l.focused.content, .chat("x"))

        l.apply(.monitorsChats)
        XCTAssertEqual(l.panes.map(\.content), [.monitors, .chats])
        XCTAssertEqual(Set(l.panes.map(\.id)), ["a", "b"])
    }

    func testChatChatWithNothingElseRecentLeavesAnEmptyChatPane() {
        var l = PaneLayout.standard
        l.apply(.chatChat)
        XCTAssertEqual(l.panes.map(\.content), [.empty, .empty])
        XCTAssertNotEqual(l.first.id, l.second.id)
    }

    func testTheTipOffersChatChatOnceASecondChatOpensWhileOneRuns() {
        let l = layout(.chats, .chat("x"))
        XCTAssertTrue(l.offersChatChat(opening: "y", running: ["x"]))
        XCTAssertFalse(l.offersChatChat(opening: "y", running: []), "nothing running: just switch")
        XCTAssertFalse(l.offersChatChat(opening: "x", running: ["x"]), "the same chat")
        XCTAssertFalse(layout(.chat("x"), .chat("z")).offersChatChat(opening: "y", running: ["x"]), "already two chats")
        var taken = l
        taken.takeChatChat(adding: "y")
        XCTAssertEqual(taken.arrangement, .chatChat)
        XCTAssertEqual(taken.pane("b")?.content, .chat("x"), "the running chat keeps its pane")
        XCTAssertEqual(taken.pane("a")?.content, .chat("y"))
        XCTAssertEqual(taken.focused.content, .chat("y"))
    }

    func testOpenTallNeverPutsTheListUnderAChat() {
        // Chats + Chat → Chat over Monitors, the list behind the chat's back button.
        let l = layout(.chats, .chat("x"))
        let d = l.display(.openTall)
        XCTAssertEqual(d.mode, .stacked)
        XCTAssertEqual(d.panes.map(\.content), [.chat("x"), .monitors])
        XCTAssertEqual(d.panes.map(\.id), ["b", "a"])
        XCTAssertEqual(d.listBehindId, "b")
        XCTAssertEqual(l.panes.map(\.content), [.chats, .chat("x")], "only the display changes; wide again restores it")

        // Monitors + Chats → the list goes on top.
        let m = layout(.monitors, .chats).display(.openTall)
        XCTAssertEqual(m.panes.map(\.content), [.chats, .monitors])
        XCTAssertNil(m.listBehindId)

        // Two chats stack as they are.
        let c = layout(.chat("x"), .chat("y")).display(.openTall)
        XCTAssertEqual(c.panes.map(\.content), [.chat("x"), .chat("y")])
    }

    func testWideAndBookAreSideBySideClosedAndTabletopAreOnePane() {
        let l = layout(.chat("x"), .chat("y"), focus: "b")
        XCTAssertEqual(l.display(.openWide).mode, .sideBySide)
        XCTAssertEqual(l.display(.book).mode, .sideBySide)
        let closed = l.display(.closed)
        XCTAssertEqual(closed.mode, .single)
        XCTAssertEqual(closed.shownId, "b", "closing shows the chat that was focused")
        let table = l.display(.tabletop)
        XCTAssertEqual(table.mode, .single)
        XCTAssertEqual(table.shownId, "b")
        XCTAssertTrue(table.flex)
        XCTAssertFalse(l.display(.openWide).flex)
        XCTAssertEqual(l.focusedChatId, "y")
        XCTAssertEqual(layout(.chats, .monitors, focus: "a").focusedChatId, nil)
        XCTAssertEqual(layout(.chat("x"), .monitors, focus: "b").focusedChatId, "x")
    }

    func testRotationMakesTheFocusedChatThePrimaryOne() {
        var l = layout(.chat("x"), .chat("y"), focus: "b")
        l.promoteFocused()
        XCTAssertEqual(l.first.content, .chat("y"))
        XCTAssertEqual(l.first.id, "b")
        var list = layout(.chats, .chat("x"), focus: "b")
        list.promoteFocused()
        XCTAssertEqual(list.first.content, .chats, "only two chats are reordered")
    }

    func testSavedPerComputerAndReadBack() throws {
        var l = layout(.chat("x:1"), .monitors, focus: "a", split: 0.55)
        l.toggleMaximized("a")
        let data = try XCTUnwrap(l.encoded)
        XCTAssertEqual(PaneLayout.parse(data), l)
        XCTAssertNil(PaneLayout.parse(nil))
        XCTAssertNil(PaneLayout.parse(Data("{}".utf8)))
        XCTAssertNil(PaneLayout.parse(Data(#"{"panes":[{"id":"a","content":"chats"}],"split":0.5,"focusedId":"a"}"#.utf8)))
        XCTAssertNil(PaneLayout.parse(Data(#"{"panes":[{"id":"a","content":"chats"},{"id":"b","content":"files"}],"split":0.5,"focusedId":"a"}"#.utf8)))
        let odd = try XCTUnwrap(PaneLayout.parse(Data(#"{"panes":[{"id":"a","content":"chats"},{"id":"b","content":"chat:s1"}],"split":2,"focusedId":"zz"}"#.utf8)))
        XCTAssertEqual(odd.split, 0.65, "a saved split is clamped")
        XCTAssertEqual(odd.focusedId, "b", "an unknown focus falls back to the second pane")
    }

    func testPaneContentEncoding() {
        for c in [PaneContent.chats, .chat("s_1:x"), .newChat, .monitors, .empty] {
            XCTAssertEqual(PaneContent(encoded: c.encoded), c)
        }
        XCTAssertNil(PaneContent(encoded: "chat:"))
        XCTAssertNil(PaneContent(encoded: "settings"))
    }

    func testTheHingeFixesTheDivider() {
        XCTAssertEqual(PaneLayout.hingeSplit(hingeStart: 400, hingeEnd: 420, length: 820), 0.5)
        XCTAssertNil(PaneLayout.hingeSplit(hingeStart: 0, hingeEnd: 10, length: 0))
        XCTAssertNil(PaneLayout.hingeSplit(hingeStart: 500, hingeEnd: 900, length: 820))
    }

    func testTabletopKeepsEveryControlOffTheHinge() throws {
        // A 900 pt tall view starting at 40 pt, the hinge at 440–464 in the window.
        let f = try XCTUnwrap(PaneFlex(hingeMinY: 440, hingeMaxY: 464, frameMinY: 40, frameHeight: 900))
        XCTAssertEqual(f.top, 400, "the transcript ends where the hinge starts")
        XCTAssertEqual(f.gap, 24)
        XCTAssertEqual(f.lowerStart, 424, "the composer starts below the hinge")
        XCTAssertNil(PaneFlex(hingeMinY: 10, hingeMaxY: 30, frameMinY: 40, frameHeight: 900), "a hinge above the view")
        XCTAssertNil(PaneFlex(hingeMinY: 1000, hingeMaxY: 1024, frameMinY: 40, frameHeight: 900), "a hinge below the view")
    }
}
