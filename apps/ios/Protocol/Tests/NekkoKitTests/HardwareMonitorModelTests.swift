import Foundation
import XCTest
@testable import NekkoKit
@testable import NekkoProtocol

/// The Expert monitor and the chat's context gauge against a fake computer.
extension BeyondTests {
    func monitorReplies(_ c: FakeConnection) {
        c.replies[MonitorChannels.systemStats] = { _ in ["cpuPct": 12, "memUsedMB": 1024, "memTotalMB": 4096] }
        c.replies[MonitorChannels.gpuStats] = { _ in ["totalMB": 8192, "usedMB": 2048, "devices": [["name": "RTX", "utilizationPct": 40]]] }
        c.replies[MonitorChannels.engineStatus] = { _ in
            ["installed": true, "running": true, "resident": [["id": "gemma", "contextLength": 32768, "vramBytes": 3_000_000_000]]]
        }
    }

    func testTheMonitorReadsHardwareAndLoadedModels() async throws {
        let (s, c) = try await makeStore()
        monitorReplies(c)
        let m = HardwareMonitorModel(store: s)
        await m.refresh()
        XCTAssertTrue(m.loaded)
        XCTAssertNil(m.error)
        XCTAssertEqual(m.system?.cpuPct, 12)
        XCTAssertEqual(m.gpu?.devices.first?.name, "RTX")
        XCTAssertEqual(m.engine?.resident.map(\.id), ["gemma"])
        XCTAssertEqual(c.callsTo(MonitorChannels.systemStats).first, [])
    }

    func testAnOlderComputerSaysItHasNoMonitors() async throws {
        let (s, _) = try await makeStore()
        let m = HardwareMonitorModel(store: s)
        await m.refresh()
        XCTAssertNil(m.system)
        XCTAssertNotNil(m.error)
    }

    func testUnloadingAModelNamesTheModelServerAndRereads() async throws {
        let (s, c) = try await makeStore()
        monitorReplies(c)
        c.replies[MonitorChannels.modelUnload] = { args in
            XCTAssertEqual(args, [.string(engineProviderId), "gemma"])
            return ["ok": true, "message": "Unloaded gemma."]
        }
        let m = HardwareMonitorModel(store: s)
        let message = try await m.unload("gemma")
        XCTAssertEqual(message, "Unloaded gemma.")
        XCTAssertNil(m.unloading)
        XCTAssertEqual(c.callsTo(MonitorChannels.engineStatus).count, 1, "re-read after unloading")

        c.replies[MonitorChannels.modelUnload] = { _ in ["ok": false, "message": "Model Server is stopped."] }
        do {
            try await m.unload("gemma")
            XCTFail("a refused unload throws")
        } catch {
            XCTAssertEqual(error.localizedDescription, "Model Server is stopped.")
        }
    }

    func testModelServerSettingsLoadingAndUnloadingAll() async throws {
        let (s, c) = try await makeStore()
        monitorReplies(c)
        c.replies[MonitorChannels.engineStatus] = { _ in
            ["installed": true, "running": true, "resident": [["id": "gemma"]],
             "settings": ["maxLoaded": 2, "idleTtlSeconds": 900, "jitLoad": true]]
        }
        c.replies[MonitorChannels.modelLoad] = { _ in ["ok": true] }
        c.replies[MonitorChannels.unloadAll] = { _ in ["ok": true] }
        c.replies[MonitorChannels.engineSettings] = { args in args[0] }
        let m = HardwareMonitorModel(store: s)
        await m.refresh()
        XCTAssertEqual(m.engine?.server, ModelServerSettings(maxLoaded: 2, idleTtlSeconds: 900, jitLoad: true, devicesChoose: true),
                       "devices choose unless the server says otherwise")
        try await m.load("qwen")
        XCTAssertEqual(c.callsTo(MonitorChannels.modelLoad).last, [.string(engineProviderId), "qwen"])
        try await m.unloadAll()
        XCTAssertEqual(c.callsTo(MonitorChannels.unloadAll).count, 1)
        try await m.setServer(["maxLoaded": 3])
        XCTAssertEqual(c.callsTo(MonitorChannels.engineSettings).last, [["maxLoaded": 3]])
        XCTAssertEqual(ModelServerSettings.from(["clientModelSettings": false])?.devicesChoose, false)
        XCTAssertNil(ModelServerSettings.from(nil), "an older computer sends none")
    }

    func testTheChatReadsItsContextAndEffort() async throws {
        let (s, c) = try await makeStore()
        c.replies[MonitorChannels.contextPreview] = { args in
            XCTAssertEqual(args, ["s1"])
            return ["usedTokens": 4000, "contextWindow": 32000, "sources": ["conversation": 3000, "system": 1000]]
        }
        let chat = ChatModel(sessionId: "s1", store: s)
        await chat.reload()
        await settle()
        XCTAssertEqual(chat.context?.usedTokens, 4000)
        XCTAssertEqual(chat.contextTokens, 4000)
        XCTAssertEqual(chat.context?.fraction, 0.125)

        try await chat.setOptions(effort: .high)
        XCTAssertEqual(c.callsTo(Channels.sessionSetOptions).last, ["s1", ["effort": "high"]])
    }

    func testTheLiveContextCountMovesInStepsWhileAReplyStreams() async throws {
        let (s, c) = try await makeStore()
        c.replies[MonitorChannels.contextPreview] = { _ in ["usedTokens": 4000, "contextWindow": 32000] }
        let chat = ChatModel(sessionId: "s1", store: s)
        chat.start()
        defer { chat.stop() }
        await settle()
        // 100 characters is about 25 tokens: under a step, so the gauge stays put.
        c.event(["type": "text", "sessionId": "s1", "delta": .string(String(repeating: "a", count: 100))])
        await settle()
        XCTAssertTrue(chat.turn.running)
        XCTAssertEqual(chat.contextTokens, 4000)
        // 2,100 characters is about 525 tokens: two whole steps.
        c.event(["type": "text", "sessionId": "s1", "delta": .string(String(repeating: "b", count: 2000))])
        await settle()
        XCTAssertEqual(chat.contextTokens, 4000 + 2 * ChatModel.contextStep)
    }
}
