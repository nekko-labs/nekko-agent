import Foundation
import XCTest
@testable import NekkoKit
@testable import NekkoProtocol

/// New chat's Auto: a local-model chat starts on a free paired computer.
@MainActor
final class MachinePickTests: XCTestCase {
    let idle = ComputerUse()
    let atDesk = ComputerUse(userActive: true)

    func testAFreeComputerWinsOverTheOneUsedLastWhenThatOneIsBusy() {
        let pick = MachinePicker.pick([
            MachineCandidate(id: "mac", conn: .online, running: 1, use: atDesk),
            MachineCandidate(id: "pc", conn: .online, use: idle),
        ], lastUsed: "mac")
        XCTAssertEqual(pick, MachinePick(computerId: "pc", reason: .free, skipped: ["mac"]))
    }

    func testSomeoneAtTheKeyboardCountsAsBusy() {
        let pick = MachinePicker.pick([
            MachineCandidate(id: "mac", conn: .online, use: atDesk),
            MachineCandidate(id: "pc", conn: .online, use: idle),
        ], lastUsed: "mac")
        XCTAssertEqual(pick.computerId, "pc")
    }

    func testWithBothFreeTheOneUsedLastStays() {
        let pick = MachinePicker.pick([
            MachineCandidate(id: "pc", conn: .online, use: idle),
            MachineCandidate(id: "mac", conn: .online, use: idle),
        ], lastUsed: "mac")
        XCTAssertEqual(pick, MachinePick(computerId: "mac", reason: .free, skipped: []))
    }

    func testOnBatteryOrHotLosesATie() {
        let pick = MachinePicker.pick([
            MachineCandidate(id: "laptop", conn: .online, use: ComputerUse(strained: true)),
            MachineCandidate(id: "studio", conn: .online, use: idle),
        ], lastUsed: nil)
        XCTAssertEqual(pick.computerId, "studio")
    }

    func testAComputerThatDoesNotSayCountsAsFreeButBelowOneThatDoes() {
        let pick = MachinePicker.pick([
            MachineCandidate(id: "old", conn: .online, use: nil),
            MachineCandidate(id: "new", conn: .online, use: idle),
        ], lastUsed: nil)
        XCTAssertEqual(pick.computerId, "new")
        let only = MachinePicker.pick([
            MachineCandidate(id: "mac", conn: .online, running: 2),
            MachineCandidate(id: "old", conn: .online, use: nil),
        ], lastUsed: "mac")
        XCTAssertEqual(only, MachinePick(computerId: "old", reason: .free, skipped: ["mac"]))
    }

    func testOfflineOrWithoutAModelServerIsNeverPicked() {
        let pick = MachinePicker.pick([
            MachineCandidate(id: "mac", conn: .online, running: 1),
            MachineCandidate(id: "asleep", conn: .offline, use: nil),
            MachineCandidate(id: "cloudy", conn: .online, use: idle, hasLocalModel: false),
        ], lastUsed: "mac")
        XCTAssertEqual(pick, MachinePick(computerId: "mac", reason: .allBusy, skipped: []))
    }

    func testAllBusyFallsBackToTheOneUsedLast() {
        let pick = MachinePicker.pick([
            MachineCandidate(id: "pc", conn: .online, use: atDesk),
            MachineCandidate(id: "mac", conn: .online, running: 3),
        ], lastUsed: "mac")
        XCTAssertEqual(pick, MachinePick(computerId: "mac", reason: .allBusy, skipped: []))
    }

    func testNoneOnlineKeepsTheOneUsedLast() {
        let pick = MachinePicker.pick([
            MachineCandidate(id: "pc", conn: .offline),
            MachineCandidate(id: "mac", conn: .connecting),
        ], lastUsed: "mac")
        XCTAssertEqual(pick, MachinePick(computerId: "mac", reason: .noneAvailable, skipped: []))
    }

    func testTheComputerSaysOnlyYesOrNo() {
        let raw: JSONValue = ["userActive": false, "chatActive": false, "headless": true, "strain": ["hot"]]
        XCTAssertEqual(ComputerUse.from(raw), ComputerUse(userActive: false, chatActive: false, headless: true, strained: true))
        XCTAssertNil(ComputerUse.from(nil), "an older computer has no activity:state")
        XCTAssertNil(ComputerUse.from(["error": "nope"]))
    }

    // MARK: Over the fleet's links

    var connections: [FakeConnection] = []

    /// `aaaa` is busy at the desk with a model server; `bbbb` is idle with one, its `small` model loaded.
    func makeStore() -> ComputersStore {
        var n = 0
        return ComputersStore(
            store: MemoryStore(),
            makeConnection: { cfg in
                let c = FakeConnection(config: cfg)
                let busy = cfg.room == "aaaa"
                c.replies = [
                    Channels.sessionsSummaries: { _ in [] },
                    Channels.providersList: { _ in [["id": "ollama", "kind": "ollama", "label": "Ollama", "enabled": true],
                                                    ["id": "claude", "kind": "anthropic", "label": "Claude", "enabled": true]] },
                    Channels.modelsList: { args in
                        args.first == "ollama" ? [["id": "big", "name": "Big"], ["id": "small", "name": "Small", "loaded": .bool(!busy)]] : []
                    },
                    Channels.activityState: { _ in ["userActive": .bool(busy), "chatActive": false, "headless": false, "strain": []] },
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

    /// Two computers, two host keys: a known host key is the same computer re-paired.
    func link(_ room: String) -> PairingLink {
        PairingLink(relayUrl: "wss://relay.example", room: room, key: "00112233445566778899aabbccddeeff",
                    hostKey: room == "aaaa" ? testHostKey : otherTestHostKey, pair: nil)
    }

    func settle() async {
        for _ in 0..<20 { await Task.yield() }
        try? await Task.sleep(nanoseconds: 30_000_000)
        for _ in 0..<20 { await Task.yield() }
    }

    func testThePhoneAsksEveryComputerAndPicksTheFreeOne() async throws {
        let s = makeStore()
        s.load()
        let b = try await s.pair(link("bbbb"))
        connections.last?.online()
        await settle()
        let a = try await s.pair(link("aaaa"))
        connections.last?.online()
        await settle()
        XCTAssertEqual(s.activeId, a)

        let pick = await s.pickMachine(lastUsed: a)
        XCTAssertEqual(pick, MachinePick(computerId: b, reason: .free, skipped: [a]))
        for c in connections { XCTAssertEqual(c.callsTo(Channels.activityState).first, [], "never sets the threshold") }

        // The model to start with there: the one asked for if it has it, else one already loaded.
        let same = await s.localModel(on: b, prefer: [("ollama", "big")])
        XCTAssertEqual(same.map { [$0.0, $0.1] }, ["ollama", "big"])
        let loaded = await s.localModel(on: b, prefer: [("ollama", "gone")])
        XCTAssertEqual(loaded.map { [$0.0, $0.1] }, ["ollama", "small"])

        // Provider ids belong to each computer. Keep the same model even
        // when the target's model server has a different id.
        let target = try XCTUnwrap(connections.first { $0.config.room == "bbbb" })
        target.replies[Channels.providersList] = { _ in
            [["id": "studio-ollama", "kind": "ollama", "label": "Ollama", "enabled": true]]
        }
        target.replies[Channels.modelsList] = { _ in
            [["id": "big", "name": "Big"], ["id": "small", "name": "Small", "loaded": true]]
        }
        let renamed = await s.localModel(on: b, prefer: [("mac-ollama", "big"), ("studio-ollama", "small")])
        XCTAssertEqual(renamed.map { [$0.0, $0.1] }, ["studio-ollama", "big"])

        // Offline, it isn't asked and isn't picked.
        try XCTUnwrap(connections.first { $0.config.room == "bbbb" }).status(RelayStatus(.offline))
        await settle()
        let after = await s.pickMachine(lastUsed: a)
        XCTAssertEqual(after, MachinePick(computerId: a, reason: .allBusy, skipped: []))
    }
}
