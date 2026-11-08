import Foundation
import XCTest
@testable import NekkoKit
@testable import NekkoProtocol

/// Deliberately ignores cancellation, like a system authorization already in progress.
private actor ImageCallGate {
    private var entered = false
    private var observer: CheckedContinuation<Void, Never>?
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func pause() async {
        entered = true
        observer?.resume()
        observer = nil
        await withCheckedContinuation { waiters.append($0) }
    }
    func waitForEntry() async {
        if !entered { await withCheckedContinuation { observer = $0 } }
    }
    func open() {
        let pending = waiters
        waiters = []
        for waiter in pending { waiter.resume() }
    }
}

private final class ImageLifecycleConnection: FakeConnection, ProofCaller, @unchecked Sendable {
    var modelsReply: (@Sendable () async throws -> JSONValue)?
    var generationReply: (@Sendable () async throws -> JSONValue)?
    var runningReply: (@Sendable () async throws -> JSONValue)?

    override func call(_ channel: String, _ args: [JSONValue], timeout: TimeInterval?) async throws -> JSONValue {
        let reply: (@Sendable () async throws -> JSONValue)? = lock.withLock {
            switch channel {
            case Channels.engineModels: return modelsReply
            case Channels.chatGenerateImage: return generationReply
            case Channels.monitorSummary: return runningReply
            default: return nil
            }
        }
        if let reply {
            lock.withLock { calls.append((channel, args)) }
            return try await reply()
        }
        return try await super.call(channel, args, timeout: timeout)
    }
    func call(_ channel: String, _ args: [JSONValue], proof: JSONValue?, timeout: TimeInterval?) async throws -> JSONValue {
        if channel == Channels.chatGenerateImage { XCTAssertNotNil(proof) }
        return try await call(channel, args, timeout: timeout)
    }
}

private final class ImageGatedSigner: ChangeSigner, Sendable {
    let gate: ImageCallGate
    let signer = SoftwareChangeSigner()
    init(_ gate: ImageCallGate) { self.gate = gate }
    func publicKey() throws -> Data { try signer.publicKey() }
    func sign(_ message: Data) async throws -> Data {
        if String(decoding: message, as: UTF8.self).contains("\nchat:generateImage\n") { await gate.pause() }
        return try await signer.sign(message)
    }
}

@MainActor
final class ImageChatLifecycleTests: XCTestCase {
    private let catalog: JSONValue = [["id": "image/acme/cat", "name": "Cat", "kind": "image", "format": "gguf", "state": "available"]]
    private let params = ImageChatParams(modelId: "image/acme/cat")

    private func online() async throws -> (ComputersStore, ImageLifecycleConnection, ChatModel) {
        var connection: ImageLifecycleConnection!
        let settings = params.json
        let catalog = catalog
        let store = ComputersStore(store: MemoryStore(), makeConnection: { cfg in
            let c = ImageLifecycleConnection(config: cfg)
            c.replies = [
                Channels.appInfo: { _ in ["capabilities": ["imageGeneration": true]] },
                Channels.engineModels: { _ in catalog },
                Channels.sessionGet: { _ in ["id": "s", "chatType": "image", "imageParams": settings, "messages": []] },
                Channels.chatPending: { _ in [:] },
            ]
            connection = c
            return c
        }, deviceName: { "iPhone" }, deriveKey: { _, _ in Data(repeating: 1, count: 32) })
        store.load()
        try await store.pair(PairingLink(relayUrl: "wss://r", room: "a1b2c3d4e5f60718", key: "00112233445566778899aabbccddeeff", hostKey: testHostKey))
        store.changeSigner = SoftwareChangeSigner()
        connection.online()
        for _ in 0..<30 { await Task.yield() }
        await store.refresh()
        let chat = ChatModel(sessionId: "s", store: store)
        await chat.start()?.value
        return (store, connection, chat)
    }

    func testRustModelProjectionAndExactIntegerPayloadGolden() throws {
        let file = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("crates/nekko-remote/tests/golden/phone-image.json")
        guard let data = try? Data(contentsOf: file) else { throw XCTSkip("repository sources not available") }
        let golden = try JSONValue.parse(data)
        // This is Rust's redacted phone projection, not the desktop engine's raw modality rows.
        let models = ImageChatModel.list(golden["models"]?["output"])
        XCTAssertEqual(models.map(\.id), ["image/sd", "image/error"])
        XCTAssertEqual(models.map(\.state), ["loaded", "error"])
        XCTAssertEqual(models.map(\.format), ["gguf", "gguf"])
        let requests = try XCTUnwrap(golden["requests"]?.array).filter { $0["problem"] == .null }
        XCTAssertFalse(requests.isEmpty)
        for request in requests {
            let input = try XCTUnwrap(request["input"])
            let params = try XCTUnwrap(ImageChatParams.from(input["params"]))
            XCTAssertTrue(params.valid)
            let actual = params.generation(sessionId: try XCTUnwrap(input.str("sessionId")), prompt: try XCTUnwrap(input.str("prompt")))
            // Both the signed canonical bytes and the serialized wire bytes must agree with the host's input.
            let expected = try ChangeProof.canonicalJSON(.array([input]))
            XCTAssertEqual(try ChangeProof.canonicalJSON(.array([actual])), expected)
            XCTAssertEqual(try ChangeProof.canonicalJSON(JSONValue.parse(JSONValue.array([actual]).serialized())), expected)
        }
        var fractional = params
        fractional.cfgScale = 4.5
        XCTAssertFalse(fractional.valid)
        XCTAssertEqual(fractional.json.dbl("cfgScale"), 4.5, "Do not silently round desktop settings")
        XCTAssertThrowsError(try ChangeProof.canonicalJSON(.array([fractional.generation(sessionId: "s", prompt: "cat")])))
    }

    func testConcurrentSendIsReservedBeforeModelDiscovery() async throws {
        let (_, c, chat) = try await online()
        defer { chat.stop() }
        let gate = ImageCallGate()
        let catalog = catalog
        c.modelsReply = { await gate.pause(); return catalog }
        let first = Task { try await chat.send("first") }
        await gate.waitForEntry()
        XCTAssertTrue(chat.sending, "Reserve before the first await, not after discovery")
        let second = Task { () -> Bool in
            do { _ = try await chat.send("second"); return false }
            catch { return true }
        }
        for _ in 0..<30 { await Task.yield() }
        await gate.open()
        _ = try await first.value
        let refused = await second.value
        XCTAssertTrue(refused)
        XCTAssertEqual(c.callsTo(Channels.chatGenerateImage).count, 1)
    }

    func testStopDuringAuthorizationNeverDispatchesLateImage() async throws {
        let (store, c, chat) = try await online()
        defer { chat.stop() }
        let gate = ImageCallGate()
        store.changeSigner = ImageGatedSigner(gate)
        let send = Task { try await chat.send("cat") }
        await gate.waitForEntry()
        chat.abort()
        for _ in 0..<30 { await Task.yield() }
        await gate.open()
        do { _ = try await send.value; XCTFail("Stop must cancel the pending image request") }
        catch {}
        XCTAssertTrue(c.callsTo(Channels.chatGenerateImage).isEmpty)
        XCTAssertEqual(c.callsTo(Channels.chatAbort), [["s"]])
        XCTAssertFalse(chat.sending)
        XCTAssertFalse(chat.running)
    }

    func testStopDuringDiscoveryNeverDispatchesLateImage() async throws {
        let (_, c, chat) = try await online()
        defer { chat.stop() }
        let gate = ImageCallGate()
        let catalog = catalog
        c.modelsReply = { await gate.pause(); return catalog }
        let send = Task { try await chat.send("cat") }
        await gate.waitForEntry()
        chat.abort()
        await gate.open()
        do { _ = try await send.value; XCTFail("Stop must cancel discovery before generation") }
        catch {}
        XCTAssertTrue(c.callsTo(Channels.chatGenerateImage).isEmpty)
    }

    func testRustImageStatusMarksRunningAndExposesStop() async throws {
        let (_, c, chat) = try await online()
        defer { chat.stop() }
        let event = try XCTUnwrap(AgentEvent.from(["type": "image_status", "sessionId": "s", "stage": "generating", "label": "Generating image"]))
        chat.onEvent(event)
        XCTAssertTrue(chat.running, "A desktop-started image turn must expose Stop and block a second prompt")
        XCTAssertEqual(ActivityTracker.next([:], event)["s"], .running)
        chat.abort()
        for _ in 0..<30 { await Task.yield() }
        XCTAssertEqual(c.callsTo(Channels.chatAbort), [["s"]])
        chat.onEvent(.done(sessionId: "s", messageId: nil))
        XCTAssertFalse(chat.running)
    }

    func testReopeningImageChatReadsHostRunningImageTurns() async throws {
        let (_, c, chat) = try await online()
        defer { chat.stop() }
        // Rust projects its internal chat:running into the phone's capped monitor view.
        c.replies[Channels.monitorSummary] = { _ in ["running": [["id": "s", "step": "working"]]] }
        await chat.reload()
        XCTAssertTrue(chat.running)
        c.replies[Channels.monitorSummary] = { _ in ["running": []] }
        await chat.reload()
        XCTAssertTrue(chat.running, "Absence from a capped list is not proof that the turn ended")
        chat.onEvent(.done(sessionId: "s", messageId: nil))
        await chat.reload()
        XCTAssertFalse(chat.running)
        XCTAssertTrue(c.callsTo("chat:running").isEmpty, "Never call the computer-only raw channel")
    }

    func testRunningSnapshotCannotOverrideNewerStartOrEndEvent() async throws {
        let (_, c, chat) = try await online()
        defer { chat.stop() }
        for running in [true, false] {
            let gate = ImageCallGate()
            c.runningReply = { await gate.pause(); return ["running": running ? [] : [["id": "s"]]] }
            let read = Task { await chat.reload() }
            await gate.waitForEntry()
            chat.onEvent(running ? .other(sessionId: "s", type: "image_status") : .done(sessionId: "s", messageId: nil))
            await gate.open()
            await read.value
            XCTAssertEqual(chat.running, running)
        }
    }

    func testHostErrorEventWithNullReplyIsNotSuccess() async throws {
        let (_, c, chat) = try await online()
        defer { chat.stop() }
        c.generationReply = {
            await MainActor.run { chat.onEvent(.error(sessionId: "s", message: "Diffusion runtime failed")) }
            return .null // image_turns.rs emits error and returns Ok(null).
        }
        do { _ = try await chat.send("cat"); XCTFail("The composer must keep its prompt on generation failure") }
        catch { XCTAssertTrue(error.localizedDescription.contains("Diffusion runtime failed")) }
        XCTAssertTrue(c.callsTo(Channels.chatSend).isEmpty)
        XCTAssertFalse(chat.sending)
        XCTAssertFalse(chat.running)
    }
}
