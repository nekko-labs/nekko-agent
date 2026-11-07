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
    func makeStore(offlineFiles: OfflineFiles? = nil, stayConnected: Bool = true) -> ComputersStore {
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
            offlineFiles: offlineFiles,
            draftDebounce: 60,
            stayConnected: stayConnected)
    }

    func link(_ room: String) -> PairingLink {
        PairingLink(relayUrl: "wss://relay.example", room: room, key: key, hostKey: String(repeating: String(room.first!), count: 87) + "=", pair: nil)
    }

    func settle() async {
        for _ in 0..<20 { await Task.yield() }
        try? await Task.sleep(nanoseconds: 30_000_000)
        for _ in 0..<20 { await Task.yield() }
    }

    func testManualDisconnectSurvivesNavigationRefreshAndRelaunch() async throws {
        let s = makeStore()
        s.load()
        let a = try await s.pair(link("aaaa"))
        let ca = try XCTUnwrap(connections.last)
        ca.online()
        let b = try await s.pair(link("bbbb"))
        let cb = try XCTUnwrap(connections.last)
        cb.online()
        await settle()

        s.setConnectionEnabled(a, false)
        XCTAssertTrue(ca.closed)
        XCTAssertFalse(s.connectionEnabled(a))
        XCTAssertEqual(s.activeId, b, "the other computer stays selected")
        XCTAssertEqual(s.state(of: b), .online)
        s.connect(a) // Opening details selects A without overriding its toggle.
        XCTAssertEqual(s.activeId, a)
        XCTAssertEqual(s.conn, .idle)
        XCTAssertEqual(s.state(of: b), .online, "the enabled computer stays in the fleet")
        s.reconnect(computer: a)
        s.nudge()
        s.networkChanged(.local)
        XCTAssertEqual(connections.count, 2)
        XCTAssertEqual(s.computers.count, 2, "disconnect is not forget")
        XCTAssertNotNil(s.secret(a))

        s.setConnectionEnabled(b, false)
        XCTAssertTrue(cb.closed)
        XCTAssertEqual(s.conn, .idle)
        connections = []
        let restored = makeStore()
        restored.load()
        restored.nudge()
        XCTAssertTrue(connections.isEmpty, "disabled pairings must not dial at launch")
        XCTAssertFalse(restored.connectionEnabled(a))
        XCTAssertFalse(restored.connectionEnabled(b))
        restored.setConnectionEnabled(a, true)
        XCTAssertEqual(connections.count, 1)
        XCTAssertEqual(connections.last?.config.room, "aaaa")
        XCTAssertFalse(restored.connectionEnabled(b))
    }

    func testDisabledColdLaunchRestoresSavedContentAndKeepsNewDraftsAndOutbox() async throws {
        let files = MemoryOfflineFiles()
        let lists = MemoryChatListCache()
        let transcripts = MemoryTranscriptCache()
        func launch() -> ComputersStore {
            let s = makeStore(offlineFiles: files)
            s.chatListCache = lists
            s.transcriptCache = transcripts
            s.load()
            return s
        }
        let s = launch()
        let a = try await s.pair(link("aaaa"))
        let c = try XCTUnwrap(connections.last)
        c.online()
        await settle()
        s.transcripts.save(session("aaaa1"))
        s.drafts.set("aaaa1", Draft(text: "Saved draft"))
        s.drafts.set(DraftStore.newChat, Draft(text: "New chat draft", modelId: "m"))
        s.drafts.flush()
        c.status(RelayStatus(.offline))
        await settle()
        let queued = s.outbox.add(chatId: "aaaa1", text: "Waiting prompt", id: "queued-a")
        let savedFiles = files.files
        s.setConnectionEnabled(a, false)
        XCTAssertTrue(c.closed)
        XCTAssertEqual(files.files, savedFiles, "disconnect must not clear drafts or queued prompts")
        XCTAssertNotNil(s.secret(a))

        connections = []
        let restored = launch()
        XCTAssertEqual(restored.activeId, a)
        XCTAssertEqual(restored.conn, .idle)
        XCTAssertFalse(restored.connectionEnabled(a))
        XCTAssertEqual(restored.summaries.map(\.id), ["aaaa2", "aaaa1"])
        XCTAssertEqual(restored.workspaces.map(\.id), ["w-aaaa"])
        XCTAssertEqual(restored.savedListAt, 1_000)
        XCTAssertFalse(restored.summariesLoaded, "the list is saved, not a live answer")
        XCTAssertEqual(restored.transcripts.saved("aaaa1")?.session.messages, session("aaaa1").messages)
        XCTAssertEqual(restored.drafts.draft("aaaa1").text, "Saved draft")
        XCTAssertEqual(restored.drafts.draft(DraftStore.newChat).modelId, "m")
        XCTAssertEqual(restored.outbox.items.map(\.id), [queued.id])
        XCTAssertThrowsError(try restored.remote())

        restored.connect(a) // Opening details selects local state, never enables the connection.
        restored.reconnect(computer: a)
        restored.reconnect()
        restored.nudge()
        restored.networkKnown(.local)
        restored.networkChanged(.local)
        restored.enterBackground(grace: 0)
        restored.suspend()
        restored.resume()
        restored.flushOutbox()
        await restored.outbox.flush()
        await settle()
        XCTAssertTrue(connections.isEmpty, "launch, navigation and lifecycle must create zero sockets")
        XCTAssertEqual(restored.outbox.items.map(\.id), [queued.id])
        XCTAssertEqual(restored.drafts.draft("aaaa1").text, "Saved draft")

        restored.drafts.set("aaaa1", Draft(text: "Edited while disabled"))
        restored.drafts.set("aaaa2", Draft(text: "Written while disabled"))
        restored.drafts.flush()
        let next = restored.outbox.add(chatId: "aaaa2", text: "Also waiting", id: "queued-next")
        let again = launch()
        XCTAssertTrue(connections.isEmpty)
        XCTAssertEqual(again.summaries.map(\.id), ["aaaa2", "aaaa1"])
        XCTAssertEqual(again.transcripts.chatIds, ["aaaa1"])
        XCTAssertEqual(again.drafts.draft("aaaa1").text, "Edited while disabled")
        XCTAssertEqual(again.drafts.draft("aaaa2").text, "Written while disabled")
        XCTAssertEqual(again.drafts.draft(DraftStore.newChat).text, "New chat draft")
        XCTAssertEqual(again.outbox.items.map(\.id), [queued.id, next.id])
        XCTAssertEqual(again.outbox.items.map(\.text), ["Waiting prompt", "Also waiting"])
    }

    func testSwitchingToDisabledComputerSelectsItsLocalStateWithoutDialing() async throws {
        for stayConnected in [false, true] {
            secure = MemoryStore()
            connections = []
            let files = MemoryOfflineFiles()
            let lists = MemoryChatListCache()
            let transcripts = MemoryTranscriptCache()
            let s = makeStore(offlineFiles: files, stayConnected: stayConnected)
            s.chatListCache = lists
            s.transcriptCache = transcripts
            s.load()
            let a = try await s.pair(link("aaaa"))
            let ca = try XCTUnwrap(connections.last)
            ca.online()
            await settle()
            s.transcripts.save(session("aaaa1"))
            s.drafts.set("aaaa1", Draft(text: "A draft")) // Switching must flush pending edits.
            s.outbox.add(chatId: "aaaa1", text: "A queued", id: "queue-a")
            s.setConnectionEnabled(a, false)
            let b = try await s.pair(link("bbbb"))
            let cb = try XCTUnwrap(connections.last)
            cb.online()
            await settle()
            s.drafts.set("bbbb1", Draft(text: "B draft"))
            s.outbox.add(chatId: "bbbb1", text: "B queued", id: "queue-b")

            s.connect(a)
            XCTAssertEqual(s.activeId, a, "disabled details must not show the previous computer")
            XCTAssertEqual(secure.get(ComputersStore.activeKey), a)
            XCTAssertEqual(s.conn, .idle)
            XCTAssertFalse(s.connectionEnabled(a))
            XCTAssertThrowsError(try s.remote())
            XCTAssertEqual(s.summaries.map(\.id), ["aaaa2", "aaaa1"])
            XCTAssertEqual(s.drafts.draft("aaaa1").text, "A draft")
            XCTAssertTrue(s.drafts.draft("bbbb1").isEmpty)
            XCTAssertEqual(s.transcripts.chatIds, ["aaaa1"])
            XCTAssertEqual(s.outbox.items.map(\.id), ["queue-a"])
            XCTAssertEqual(connections.count, 2)
            if stayConnected {
                XCTAssertFalse(cb.closed)
                XCTAssertEqual(s.state(of: b), .online)
            }
            s.drafts.set("aaaa1", Draft(text: "A edited offline"))
            s.connect(a) // Reopening the same disabled details must not reload or clear edits.
            XCTAssertEqual(s.drafts.draft("aaaa1").text, "A edited offline")
            XCTAssertEqual(s.outbox.items.map(\.id), ["queue-a"])
            s.nudge()
            s.reconnect(computer: a)
            s.networkChanged(.local)
            XCTAssertEqual(connections.count, 2)
            XCTAssertEqual(ca.connects, 1, "the disabled socket must never reopen")
            XCTAssertTrue(ca.paths.isEmpty)

            s.connect(b)
            XCTAssertEqual(s.activeId, b)
            XCTAssertEqual(s.drafts.draft("bbbb1").text, "B draft")
            XCTAssertEqual(s.outbox.items.map(\.id), ["queue-b"])
            XCTAssertEqual(connections.count, stayConnected ? 2 : 3)
            s.connect(a)
            XCTAssertEqual(s.drafts.draft("aaaa1").text, "A edited offline")
            XCTAssertEqual(s.outbox.items.map(\.id), ["queue-a"])
            XCTAssertEqual(s.conn, .idle)
            s.setConnectionEnabled(a, true)
            XCTAssertEqual(s.activeId, a)
            XCTAssertEqual(s.conn, .connecting)
            XCTAssertEqual(connections.last?.config.room, "aaaa")
            XCTAssertEqual(connections.count, stayConnected ? 3 : 4)
            XCTAssertEqual(s.drafts.draft("aaaa1").text, "A edited offline")
            XCTAssertEqual(s.outbox.items.map(\.id), ["queue-a"])
            s.disconnect()
            s.setConnectionEnabled(b, false)
            await settle()
        }
    }

    func testBackgroundClosesFleetWhenActiveComputerIsManuallyDisconnected() async throws {
        let s = makeStore()
        s.load()
        let a = try await s.pair(link("aaaa"))
        let peer = try XCTUnwrap(connections.last)
        peer.online()
        let b = try await s.pair(link("bbbb"))
        connections.last?.online()
        await settle()
        s.setConnectionEnabled(b, false)
        s.connect(b)
        XCTAssertEqual(s.summaries.map(\.id), ["bbbb2", "bbbb1"], "reopening disabled details keeps the live list even without a disk cache")
        s.enterBackground(grace: 0)
        XCTAssertTrue(peer.closed)
        s.resume()
        XCTAssertEqual(peer.connects, 2)
        XCTAssertTrue(s.connectionEnabled(a))
        XCTAssertFalse(s.connectionEnabled(b))
        XCTAssertEqual(connections.count, 2)
    }

    func testRepairExplicitlyReenablesDisconnectedComputer() async throws {
        let s = makeStore()
        s.load()
        let a = try await s.pair(link("aaaa"))
        s.setConnectionEnabled(a, false)
        let repaired = try await s.pair(link("aaaa"))
        XCTAssertEqual(repaired, a)
        XCTAssertTrue(s.connectionEnabled(a))
        XCTAssertEqual(connections.count, 2)
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

    /// One Live Activity card (#1912): a computer that is not active must not push or
    /// start a card on this phone, so its link withdraws the card registration as it
    /// comes online; made active again, it registers once more.
    func testAComputerThatIsNotActiveWithdrawsItsCard() async throws {
        let s = makeStore()
        s.load()
        s.cardLevel = .standard
        s.cardStartToken = "cd34"
        let a = try await s.pair(link("aaaa"))
        let ca = try XCTUnwrap(connections.last)
        // The second computer becomes active before the first was ever online: the switch told it nothing.
        let b = try await s.pair(link("bbbb"))
        let cb = try XCTUnwrap(connections.last)
        cb.online()
        await settle()
        XCTAssertTrue(ca.cards.isEmpty)
        XCTAssertEqual(cb.cards.last?["level"], "standard")
        XCTAssertEqual(cb.cards.last?["startToken"], "cd34")

        ca.online()
        await settle()
        let withdrawn = try XCTUnwrap(ca.cards.last)
        XCTAssertEqual([withdrawn["token"], withdrawn["startToken"], withdrawn["level"], withdrawn["computerId"]],
                       [.null, .null, "none", .string(a)])
        XCTAssertEqual(ca.callsTo(Channels.cardSet).last, [["level": "none"]])
        XCTAssertEqual(cb.cards.last?["level"], "standard", "the active computer keeps its card")

        // Opening a chat there makes it active: it registers, and the one left behind withdraws.
        s.focus(chat: "aaaa1")
        await settle()
        XCTAssertEqual(s.activeId, a)
        XCTAssertEqual(ca.cards.last?["level"], "standard")
        XCTAssertEqual(ca.cards.last?["startToken"], "cd34")
        XCTAssertEqual(cb.cards.last?["level"], "none")
        XCTAssertEqual(cb.cards.last?["computerId"], .string(b))
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
