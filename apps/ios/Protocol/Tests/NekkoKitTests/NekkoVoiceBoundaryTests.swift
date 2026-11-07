import XCTest
import NekkoProtocol
@testable import NekkoKit

private actor VoiceBoundaryCaller: Caller {
    var channels: [String] = []
    var statusReply: CheckedContinuation<JSONValue, Never>?
    func call(_ channel: String, _ args: [JSONValue], timeout: TimeInterval?) async throws -> JSONValue {
        channels.append(channel)
        if channel == Channels.voiceStatus {
            return await withCheckedContinuation { statusReply = $0 }
        }
        return .string("words")
    }
    var waiting: Bool { statusReply != nil }
    func release() { statusReply?.resume(returning: .null); statusReply = nil }
}

@MainActor
private final class VoiceBoundaryFiles: OfflineFiles {
    var saved: JSONValue?
    var writes = 0
    func load(_ computerId: String, _ name: String) -> JSONValue? { saved }
    func save(_ computerId: String, _ name: String, _ value: JSONValue) { saved = value; writes += 1 }
    func remove(_ computerId: String) { saved = nil }
}

@MainActor
final class NekkoVoiceBoundaryTests: XCTestCase {
    func testPinnedCallerCannotFollowMutableSelectionAfterCapabilityWait() async throws {
        let original = VoiceBoundaryCaller()
        let other = VoiceBoundaryCaller()
        var selected: any Caller = original
        var active = "pc"
        var state = RelayState.online
        let pin = NekkoVoiceComputer(id: "pc", caller: selected, allowed: {
            NekkoVoiceScope.permits(computerId: "pc", activeId: active, state: state)
        })
        let probe = Task { try await pin.call(Channels.voiceStatus) }
        while !(await original.waiting) { await Task.yield() }
        active = "other"
        selected = other
        await original.release()
        _ = try await probe.value
        do {
            _ = try await pin.call(Channels.voiceTranscribe, [.string("private audio")])
            XCTFail("Scope change must reject audio")
        } catch is CancellationError {} catch { XCTFail("Unexpected error: \(error)") }
        let originalCalls = await original.channels
        let otherCalls = await other.channels
        XCTAssertEqual(originalCalls, [Channels.voiceStatus])
        XCTAssertTrue(otherCalls.isEmpty)
        active = "pc"
        state = .denied
        do {
            _ = try await pin.call(Channels.voiceTranscribe)
            XCTFail("Denied must reject audio")
        } catch is CancellationError {} catch { XCTFail("Unexpected error: \(error)") }
        state = .online
        // Even if the mutable caller changed, the original pin still owns the upload.
        _ = try await pin.call(Channels.voiceTranscribe)
        let uploaded = await original.channels
        let untouched = await other.channels
        XCTAssertEqual(uploaded, [Channels.voiceStatus, Channels.voiceTranscribe])
        XCTAssertTrue(untouched.isEmpty)
        _ = selected
    }

    func testDeniedAndArchivedConfirmationNeverDispatchAndInvalidatePending() {
        let dispatcher = NekkoVoiceDispatcher()
        var context = NekkoVoiceDispatcher.Context(computerId: "pc", computerName: "PC", online: true,
            loaded: true, card: .init(chats: [], focusId: nil, more: 0, listening: false, heard: ""),
            targets: [.init(id: "chat", name: "Login")])
        for denied in [false, true] {
            context.denied = false
            context.targets[0].archived = false
            _ = dispatcher.dispatch("send to Login: hello", context: context)
            context.denied = denied
            context.targets[0].archived = !denied
            let result = dispatcher.dispatch("confirm send to Login: hello", context: context)
            guard case .message = result else { return XCTFail("Archived/denied must not dispatch") }
            context.denied = false
            context.targets[0].archived = false
            guard case .message = dispatcher.dispatch("confirm send to Login: hello", context: context) else {
                return XCTFail("Rejected confirmation must be consumed")
            }
        }
    }

    func testReadOnlyRouteCompatibilityKeepsProcessingActive() async {
        let runner = NekkoVoiceRunner()
        var shown: (Bool, String) = (false, "")
        runner.capture = { "status" }
        runner.show = { shown = ($0, $1) }
        runner.route = { text in
            XCTAssertEqual(text, "status")
            XCTAssertTrue(shown.0)
            XCTAssertEqual(shown.1, "Processing…")
            return "Status checked."
        }
        await runner.talk()
        XCTAssertFalse(shown.0)
        XCTAssertEqual(shown.1, "Status checked.")
    }

    func testScopeAllowsOfflineButNeverDeniedOrOtherComputer() {
        for state in [RelayState.idle, .connecting, .offline, .online] {
            XCTAssertTrue(NekkoVoiceScope.permits(computerId: "pc", activeId: "pc", state: state))
        }
        XCTAssertFalse(NekkoVoiceScope.permits(computerId: "pc", activeId: "pc", state: .denied))
        XCTAssertFalse(NekkoVoiceScope.permits(computerId: "pc", activeId: "other", state: .online))
        XCTAssertFalse(NekkoVoiceScope.permits(computerId: "pc", activeId: nil, state: .online))
    }

    func testOutboxFinalGuardCancelsPreparationButOfflineCommitPersists() async throws {
        let drafts = DraftStore(files: nil, debounce: 0)
        drafts.load("pc")
        let files = VoiceBoundaryFiles()
        let box = Outbox(files: files, drafts: drafts, caller: { nil })
        box.load("pc")
        let runner = NekkoVoiceRunner()
        var release: CheckedContinuation<Void, Never>?
        var shown: [(Bool, String)] = []
        runner.capture = { "confirmed words" }
        runner.show = { shown.append(($0, $1)) }
        runner.routeWithCommit = { _, permit in
            await withCheckedContinuation { release = $0 }
            _ = try await box.sendWaiting(chatId: "chat", text: "hello", wait: 0,
                                          beforeEnqueue: { permit.commit() })
            return "Queued"
        }
        let task = Task { await runner.talk() }
        while release == nil { await Task.yield() }
        XCTAssertTrue(shown.last?.0 == true)
        XCTAssertEqual(shown.last?.1, "Processing…")
        XCTAssertTrue(runner.canCancel)
        runner.cancel()
        release?.resume()
        await task.value
        XCTAssertTrue(box.items.isEmpty)
        XCTAssertEqual(shown.last?.1, "Cancelled. Nothing sent.")
        XCTAssertEqual(files.writes, 0)

        var allowed = true
        runner.routeWithCommit = { _, permit in
            allowed = false // Simulates denial/archive/scope invalidation during preparation.
            return try await box.sendWaiting(chatId: "chat", text: "hello", wait: 0,
                beforeEnqueue: { permit.commit(if: { allowed }) }) ? "Sent" : "Queued"
        }
        await runner.talk()
        XCTAssertTrue(box.items.isEmpty)
        XCTAssertEqual(files.writes, 0)
        runner.routeWithCommit = { _, permit in
            let delivered = try await box.sendWaiting(chatId: "chat", text: "hello", wait: 0,
                beforeEnqueue: { permit.commit() })
            XCTAssertFalse(runner.canCancel)
            runner.cancel()
            XCTAssertEqual(box.items.count, 1)
            return delivered ? "Sent" : "Queued"
        }
        await runner.talk()
        XCTAssertEqual(box.items.first?.text, "hello")
        XCTAssertEqual(shown.last?.1, "Queued")
        XCTAssertGreaterThan(files.writes, 0)
        let reloaded = Outbox(files: files, drafts: drafts, caller: { nil })
        reloaded.load("pc")
        XCTAssertEqual(reloaded.items.first?.text, "hello", "Committed offline work survives reload")
    }
}
