import Foundation
import XCTest
@testable import NekkoProtocol

final class ChatListLayoutTests: XCTestCase {
    private let day: Int64 = 24 * 60 * 60 * 1000
    /// 2026-10-24 12:00 UTC.
    private let now: Int64 = 1_792_843_200_000
    private var utc: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC")!
        return c
    }

    private func chats(_ json: String) throws -> [SessionSummary] {
        SessionSummary.visible(try JSONValue.parse(json))
    }

    private let folders = [WorkspaceFolder(id: "w1", name: "App"), WorkspaceFolder(id: "w2", name: "Empty")]

    func testTheDefaultViewIsTheListAsItWas() throws {
        let list = try chats("""
        [{"id":"a","title":"A","updatedAt":5},
         {"id":"b","title":"B","updatedAt":9,"workspaceId":"w1","order":2},
         {"id":"c","title":"C","updatedAt":3,"workspaceId":"w1","order":1},
         {"id":"e","title":"E","updatedAt":8,"workspaceId":"w1","archivedAt":100}]
        """)
        let s = ChatSections.make(list, folders: folders, view: .standard, activity: [:], now: now, calendar: utc)
        XCTAssertEqual(s.map(\.name), ["General", "App", "Empty"])
        XCTAssertEqual(s[1].chats.map(\.id), ["c", "b", "e"], "active in dragged order, then completed")
        XCTAssertEqual(s[1].activeCount, 2)
        XCTAssertEqual(s[1].doneCount, 1)
    }

    func testHidesCompletedChatsAndEmptyFolders() throws {
        let list = try chats(#"[{"id":"e","title":"E","updatedAt":8,"workspaceId":"w1","archivedAt":100}]"#)
        var v = ChatListView.standard
        v.showCompleted = false
        v.showEmptyGroups = false
        XCTAssertEqual(ChatSections.make(list, folders: folders, view: v, activity: [:], now: now).map(\.name), [])
        v.showEmptyGroups = true
        XCTAssertEqual(ChatSections.make(list, folders: folders, view: v, activity: [:], now: now).map(\.name), ["App", "Empty"])
    }

    func testSortsByNameAndByUpdate() throws {
        let list = try chats("""
        [{"id":"a","title":"beta","updatedAt":5},
         {"id":"b","title":"Alpha","updatedAt":9},
         {"id":"c","title":"gamma 10","updatedAt":3},
         {"id":"d","title":"gamma 9","updatedAt":7}]
        """)
        let byName = ChatListView.standard.withSort(.name)
        XCTAssertTrue(byName.ascending, "names start A to Z")
        XCTAssertEqual(ChatSections.make(list, folders: [], view: byName, activity: [:], now: now)[0].chats.map(\.id), ["b", "a", "d", "c"])
        var oldest = ChatListView.standard.withSort(.updated)
        XCTAssertFalse(oldest.ascending, "dates start newest first")
        oldest.ascending = true
        XCTAssertEqual(ChatSections.make(list, folders: [], view: oldest, activity: [:], now: now)[0].chats.map(\.id), ["c", "a", "d", "b"])
    }

    func testGroupsByStatusAndDate() throws {
        let list = try chats("""
        [{"id":"a","title":"A","updatedAt":\(now - 1000)},
         {"id":"b","title":"B","updatedAt":\(now - day)},
         {"id":"c","title":"C","updatedAt":\(now - 3 * day)},
         {"id":"d","title":"D","updatedAt":\(now - 60 * day)},
         {"id":"e","title":"E","updatedAt":\(now),"archivedAt":\(now)}]
        """)
        var v = ChatListView.standard
        v.groupBy = .status
        v.showEmptyGroups = false
        let status = ChatSections.make(list, folders: [], view: v, activity: ["c": .needsYou, "a": .running], now: now, calendar: utc)
        XCTAssertEqual(status.map(\.name), ["Needs you", "Working", "Idle", "Completed"])
        XCTAssertEqual(status.map { $0.chats.map(\.id) }, [["c"], ["a"], ["b", "d"], ["e"]])

        v.groupBy = .date
        let date = ChatSections.make(list, folders: [], view: v, activity: [:], now: now, calendar: utc)
        XCTAssertEqual(date.map(\.name), ["Today", "Yesterday", "Previous 7 days", "Older", "Completed"])

        v.groupBy = .none
        XCTAssertEqual(ChatSections.make(list, folders: [], view: v, activity: [:], now: now).map(\.name), ["All chats", "Completed"])
    }

    func testShowsUpToEightRecentChatsAndAlwaysTheBusyOnes() throws {
        // 10 recent, 2 older than two weeks; one old one needs you, one old one is pinned.
        let items = (0..<12).map { i -> String in
            let at = i < 10 ? now - Int64(i) * day : now - Int64(10 + i) * day
            let pin = i == 11 ? ",\"pinned\":true" : ""
            return "{\"id\":\"c\(i)\",\"title\":\"C\(i)\",\"updatedAt\":\(at)\(pin)}"
        }
        let list = try chats("[" + items.joined(separator: ",") + "]")
        let s = ChatSections.make(list, folders: [], view: .standard, activity: ["c10": .needsYou], now: now)[0]
        let split = ChatSections.split(s, activity: ["c10": .needsYou], now: now)
        XCTAssertEqual(split.shown.map(\.id), ["c0", "c1", "c2", "c3", "c4", "c5", "c6", "c7", "c10", "c11"])
        XCTAssertEqual(split.hidden, 2)
    }

    func testGroupOrderFollowsTheDraggedOrder() throws {
        let list = try chats(#"[{"id":"a","title":"A","updatedAt":5},{"id":"b","title":"B","updatedAt":5,"workspaceId":"w1"}]"#)
        let s = ChatSections.make(list, folders: folders, view: .standard, activity: [:], groupOrder: ["w2", "w1"], now: now)
        XCTAssertEqual(s.map(\.name), ["Empty", "App", "General"], "a group the saved order doesn't name keeps its place after")
        XCTAssertEqual(ChatGroupOrder.move(["a", "b", "c"], "c", before: "a"), ["c", "a", "b"])
        XCTAssertEqual(ChatGroupOrder.move(["a", "b", "c"], "a", before: nil), ["b", "c", "a"])
        XCTAssertEqual(ChatGroupOrder.move(["a", "b", "c"], "x", before: "a"), ["a", "b", "c"])
    }

    func testSavedViewsKeepWhatIsStillValid() throws {
        var v = ChatListView.standard
        v.groupBy = .date
        v.showPreviews = false
        XCTAssertEqual(ChatListView.parse(v.encoded), v)
        let partial = ChatListView.parse(Data(#"{"groupBy":"status","sortBy":"created","showCompleted":false}"#.utf8))
        XCTAssertEqual(partial.groupBy, .status)
        XCTAssertEqual(partial.sortBy, .manual, "an unknown sort falls back")
        XCTAssertFalse(partial.showCompleted)
        XCTAssertEqual(ChatListView.parse(Data("nope".utf8)), .standard)
        XCTAssertEqual(ChatListView.parse(nil), .standard)
    }
}
