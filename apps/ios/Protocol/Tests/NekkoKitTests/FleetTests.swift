import Foundation
import XCTest
@testable import NekkoKit
@testable import NekkoProtocol

/// Every paired computer stays connected (`stayConnected`): the chat list reads
/// all of them, and switching hands the links over instead of dialing again.
@MainActor
final class FleetTests: XCTestCase {
    let key = "00112233445566778899aabbccddeeff"
    var connections: [FakeConnection] = []
    var secure = MemoryStore()

    /// Each computer (room) answers with its own chats: `<room>1`, then the newer `<room>2`.
    func makeStore() -> ComputersStore {
        var n = 0
        return ComputersStore(
            store: secure,
            makeConnection: { cfg in
                let c = FakeConnection(config: cfg)
                let room = cfg.room
                c.replies = [
                    Channels.sessionsSummaries: { _ in [["id": .string("\(room)1"), "title": "One", "updatedAt": 5],
                                                        ["id": .string("\(room)2"), "title": "Two", "updatedAt": 6]] },
                    Channels.workspaceList: { _ in [["id": .string("w-\(room)"), "name": "App"]] },
                    Channels.appInfo: { _ in ["version": "0.9.0", "platform": "win32"] },
                ]
                self.connections.append(c)
                return c
            },
            deviceName: { "Philip’s iPhone" },
            deriveKey: { _, _ in Data(repeating: 7, count: 32) },
            newId: { n += 1; return "id-\(n)" },
            now: { 1_000 },
            summariesDebounce: 0.01,
            stayConnected: true)
    }

    func link(_ room: String) -> PairingLink {
        PairingLink(relayUrl: "wss://relay.example", room: room, key: key, hostKey: String(repeating: String(room.first!), count: 87) + "=", pair: nil)
    }

    func settle() async {
        for _ in 0..<20 { await Task.yield() }
        try? await Task.sleep(nanoseconds: 30_000_000)
        for _ in 0..<20 { await Task.yield() }
    }

    func testRepairAnInactiveComputerDiscardsItsOldFleetConnection() async throws {
        let s = makeStore()
        s.load()
        let a = try await s.pair(link("aaaa"))
        let old = try XCTUnwrap(connections.last)
        old.online()
        await settle()
        _ = try await s.pair(link("bbbb"))
        connections.last?.online()
        await settle()
        let original = link("aaaa")
        let again = try await s.pair(PairingLink(relayUrl: "wss://new.example", room: "changed", key: key, hostKey: original.hostKey, pair: "FRESH"))
        XCTAssertEqual(again, a)
        XCTAssertEqual(s.computers.count, 2)
        XCTAssertTrue(old.closed)
        XCTAssertEqual(connections.last?.config.relayUrl, "wss://new.example")
        XCTAssertEqual(connections.last?.config.room, "changed")
        XCTAssertEqual(connections.last?.config.pairCode, "FRESH")
    }

    func testEveryComputerStaysConnectedAndTheListHoldsAllTheirChats() async throws {
        let s = makeStore()
        s.load()
        let a = try await s.pair(link("aaaa"))
        let ca = try XCTUnwrap(connections.last)
        ca.online()
        await settle()
        XCTAssertEqual(s.chats(on: a).map(\.id), ["aaaa2", "aaaa1"])

        // A second computer becomes active; the first keeps its link, not closed and not dialed again.
        let b = try await s.pair(link("bbbb"))
        let cb = try XCTUnwrap(connections.last)
        XCTAssertEqual(connections.count, 2)
        XCTAssertFalse(ca.closed, "the computer left behind stays connected")
        XCTAssertEqual(s.activeId, b)
        XCTAssertEqual(s.state(of: a), .online)
        XCTAssertEqual(s.chats(on: a).map(\.id), ["aaaa2", "aaaa1"], "its list carries over")
        cb.online()
        await settle()

        // The aggregate: the active computer's chats first (newest first, as the list sorts), then the rest.
        XCTAssertEqual(s.chats(on: nil).map(\.id), ["bbbb2", "bbbb1", "aaaa2", "aaaa1"])
        XCTAssertEqual(Set(s.folders(on: nil).map(\.id)), ["w-aaaa", "w-bbbb"])
        XCTAssertEqual(s.computerId(ofChat: "aaaa2"), a)
        XCTAssertEqual(s.computerId(ofChat: "bbbb1"), b)

        // Who is running on the other computer, from its own event stream.
        ca.event(["type": "text", "sessionId": "aaaa1", "delta": "hi"])
        await settle()
        XCTAssertEqual(s.activity(on: nil)["aaaa1"], .running)
        XCTAssertEqual(s.activity(on: a)["aaaa1"], .running)
        XCTAssertNil(s.activity(on: b)["aaaa1"])

        // Opening a chat there takes the link over: online at once, its chats on screen, no new connection.
        s.focus(chat: "aaaa1")
        XCTAssertEqual(s.activeId, a)
        XCTAssertEqual(s.conn, .online)
        XCTAssertEqual(s.summaries.map(\.id), ["aaaa2", "aaaa1"])
        XCTAssertEqual(s.activity["aaaa1"], .running)
        XCTAssertEqual(connections.count, 2)
        XCTAssertFalse(cb.closed)
        XCTAssertEqual(s.state(of: b), .online)
        _ = try await s.remote().call(Channels.sessionGet, [.string("aaaa1")])
        XCTAssertEqual(ca.callsTo(Channels.sessionGet).count, 1, "the active computer is now the first one")
    }

    func testChatActionsReachAComputerThatIsNotActive() async throws {
        let s = makeStore()
        s.load()
        let a = try await s.pair(link("aaaa"))
        let ca = try XCTUnwrap(connections.last)
        ca.online()
        await settle()
        _ = try await s.pair(link("bbbb"))
        connections.last?.online()
        await settle()

        try await s.completeChat("aaaa1", on: a)
        XCTAssertEqual(ca.callsTo(Channels.sessionSetOptions).count, 1)
        XCTAssertEqual(s.chats(on: a).first { $0.id == "aaaa1" }?.archived, true)
        try await s.setPinned("aaaa2", true, on: a)
        XCTAssertEqual(s.chats(on: a).first { $0.id == "aaaa2" }?.pinned, true)
        try await s.deleteChat("aaaa2", on: a)
        XCTAssertEqual(ca.callsTo(Channels.sessionDelete).count, 1)
        XCTAssertEqual(s.chats(on: a).map(\.id), ["aaaa1"])

        // Not reachable: said in words, nothing sent.
        ca.status(RelayStatus(.offline))
        await settle()
        do {
            try await s.renameChat("aaaa1", to: "New", on: a)
            XCTFail("an offline computer can't take it")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("isn’t connected"))
        }
    }

    func testLoadDialsEveryComputerAndTheBackgroundClosesThemAll() async throws {
        let s = makeStore()
        s.load()
        let a = try await s.pair(link("aaaa"))
        _ = try await s.pair(link("bbbb"))
        // Relaunch: one connection per paired computer, the active one first.
        connections = []
        let s2 = makeStore()
        s2.load()
        XCTAssertEqual(connections.count, 2)
        XCTAssertTrue(connections.allSatisfy(\.connected))
        let peer = try XCTUnwrap(connections.first { $0.config.room == "aaaa" })
        XCTAssertEqual(s2.state(of: a), .connecting)
        peer.online()
        await settle()
        XCTAssertEqual(s2.chats(on: a).map(\.id), ["aaaa2", "aaaa1"])
        XCTAssertEqual(s2.computers.first { $0.id == a }?.name, "Windows PC", "named after its OS by its own link")

        s2.suspend()
        XCTAssertTrue(connections.allSatisfy(\.closed))
        s2.resume()
        XCTAssertEqual(peer.connects, 2, "dialed again on the way back")

        // Reconnect on a computer that isn't active: a fresh link, the list kept meanwhile.
        s2.reconnect(computer: a)
        XCTAssertTrue(peer.closed)
        XCTAssertEqual(connections.count, 3)
        XCTAssertEqual(s2.chats(on: a).map(\.id), ["aaaa2", "aaaa1"])

        // Forgetting it closes its link.
        let fresh = try XCTUnwrap(connections.last)
        s2.forget(a)
        XCTAssertTrue(fresh.closed)
        XCTAssertNil(s2.peers[a])
        XCTAssertEqual(s2.chats(on: nil).count, 0)
    }
}
