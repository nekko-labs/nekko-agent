import Foundation
import XCTest
@testable import NekkoKit
@testable import NekkoProtocol

@MainActor
final class MemoryChatListCache: ChatListCache {
    var lists: [String: SavedChatList] = [:]
    func load(_ computerId: String) -> SavedChatList? { lists[computerId] }
    func save(_ computerId: String, _ list: SavedChatList) { lists[computerId] = list }
    func remove(_ computerId: String) { lists[computerId] = nil }
}

final class SavedChatListTests: XCTestCase {
    func testKeepsOnlyWhatTheListShows() throws {
        let raw: JSONValue = [
            "id": "s1", "title": "Fix the build", "updatedAt": 5, "workspaceId": "w", "archivedAt": 7, "order": 1.5,
            "pinned": true, "lastReplyText": "secret reply", "firstUserText": "secret prompt", "modelId": "m", "providerId": "p",
        ]
        let s = try XCTUnwrap(SessionSummary.from(raw))
        let list = SavedChatList(savedAt: 42, summaries: [s], folders: [WorkspaceFolder(id: "w", name: "App")])
        let text = String(decoding: try JSONEncoder().encode(list.json), as: UTF8.self)
        XCTAssertFalse(text.contains("secret"), "never a reply or a prompt")
        XCTAssertFalse(text.contains("modelId"))
        let back = try XCTUnwrap(SavedChatList.from(try JSONValue.parse(text)))
        XCTAssertEqual(back.savedAt, 42)
        XCTAssertEqual(back.folders, [WorkspaceFolder(id: "w", name: "App")])
        let b = try XCTUnwrap(back.summaries.first)
        XCTAssertEqual(b.title, "Fix the build")
        XCTAssertEqual(b.workspaceId, "w")
        XCTAssertEqual(b.archivedAt, 7)
        XCTAssertTrue(b.archived)
        XCTAssertEqual(b.order, 1.5)
        XCTAssertTrue(b.pinned)
        XCTAssertNil(b.lastReplyText)
    }

    func testAnotherVersionIsIgnored() {
        XCTAssertNil(SavedChatList.from(["v": 2, "savedAt": 1, "chats": []]))
        XCTAssertNil(SavedChatList.from(["savedAt": 1]))
        XCTAssertNil(SavedChatList.from(nil))
    }
}

extension StoreTests {
    func testTheSavedListShowsUntilTheComputerAnswers() async throws {
        let cache = MemoryChatListCache()
        let s = makeStore()
        s.chatListCache = cache
        s.load()
        let id = await s.pair(PairingLink(relayUrl: "wss://r", room: room, key: key))
        XCTAssertNil(cache.lists[id], "nothing saved before the computer answers")
        connections.last!.online()
        await settle()
        XCTAssertEqual(cache.lists[id]?.summaries.map(\.id), ["s1"])
        XCTAssertEqual(cache.lists[id]?.folders.map(\.name), ["App"])
        XCTAssertNil(s.savedListAt)

        // Next launch, the computer unreachable: the saved list, marked as saved.
        let s2 = makeStore()
        s2.chatListCache = cache
        s2.load()
        XCTAssertEqual(s2.summaries.map(\.title), ["Fix it"])
        XCTAssertEqual(s2.workspaces.map(\.id), ["w"])
        XCTAssertEqual(s2.savedListAt, 1_000)
        XCTAssertFalse(s2.summariesLoaded)
        connections.last!.online()
        await settle()
        XCTAssertNil(s2.savedListAt, "live again")

        s2.forget(id)
        XCTAssertNil(cache.lists[id], "forgetting a computer drops its list")
    }

    func testNothingIsKeptUntilTheSettingIsTurnedOn() async throws {
        let s = makeStore()
        s.load()
        let id = await s.pair(PairingLink(relayUrl: "wss://r", room: room, key: key))
        connections.last!.online()
        await settle()
        let cache = MemoryChatListCache()
        XCTAssertNil(cache.lists[id])
        // Turned on while online: the list as it is now.
        s.chatListCache = cache
        XCTAssertEqual(cache.lists[id]?.summaries.map(\.id), ["s1"])
        s.chatListCache = nil
        XCTAssertNil(s.savedListAt)
    }
}
