import Foundation
import XCTest
@testable import NekkoKit
@testable import NekkoProtocol

@MainActor
final class ImageChatTests: XCTestCase {
    private var params: ImageChatParams { ImageChatParams(modelId: "flux-local") }
    private var session: JSONValue {
        ["id": "s", "title": "Images", "chatType": "image", "imageParams": params.json, "messages": [], "queue": []]
    }

    private func online() async throws -> (ComputersStore, SigningConnection) {
        var connections: [SigningConnection] = []
        let reply = session
        let store = ComputersStore(store: MemoryStore(), makeConnection: { config in
            let c = SigningConnection(config: config)
            c.replies = [
                Channels.appInfo: { _ in ["capabilities": ["imageGeneration": true]] },
                Channels.sessionGet: { _ in reply },
                Channels.engineModels: { _ in [["id": "flux-local", "name": "FLUX", "modality": "image", "path": "/must/not/be/kept"],
                                               ["id": "vision", "modality": "vision"]] },
                Channels.settingsGet: { _ in ["defaultProviderId": "cloud", "defaultModelId": "text-model"] },
                Channels.sessionCreate: { _ in ["id": "s", "messages": []] },
                Channels.sessionSetOptions: { _ in reply },
            ]
            connections.append(c)
            return c
        }, deviceName: { "iPhone" }, deriveKey: { _, _ in Data(repeating: 1, count: 32) })
        store.load()
        try await store.pair(PairingLink(relayUrl: "wss://r", room: "a1b2c3d4e5f60718", key: "00112233445566778899aabbccddeeff", hostKey: testHostKey))
        store.changeSigner = SoftwareChangeSigner()
        connections[0].online()
        for _ in 0..<50 { await Task.yield() }
        await store.refresh()
        return (store, connections[0])
    }

    func testWireParamsCapabilitiesAndImageOnlyCatalog() throws {
        XCTAssertEqual(ImageChatParams.from(params.json), params)
        XCTAssertTrue(params.valid)
        XCTAssertTrue(AppInfo.from(["capabilities": ["imageGeneration": true]]).imageGeneration)
        XCTAssertFalse(AppInfo.from(["version": "old"]).imageGeneration)
        XCTAssertFalse(AppInfo.from(nil).imageGeneration)
        let models = ImageChatModel.list([["id": "i", "kind": "image", "format": "gguf", "path": "secret"],
                                          ["id": "v", "modality": "vision"], ["id": "t"], ["modality": "image"]])
        XCTAssertEqual(models.map(\.id), ["i"])
        XCTAssertEqual(models.first?.format, "gguf")
        var bad = params
        bad.width = 513
        XCTAssertFalse(bad.valid)
        bad = params; bad.seed = -2
        XCTAssertFalse(bad.valid)
        bad = params; bad.cfgScale = 4.5
        XCTAssertFalse(bad.valid, "never silently round fractional settings from a desktop session")
        XCTAssertEqual(ImageChatParams.from(bad.json)?.cfgScale, 4.5)
        XCTAssertTrue(Channels.change.contains(Channels.chatGenerateImage))
        XCTAssertTrue(Channels.all.contains(Channels.engineModels))
        XCTAssertFalse(Channels.change.contains(Channels.engineModels))
        XCTAssertFalse(Channels.all.contains("image:fetch"))
    }

    func testCreateUsesWorkspaceThenImageOptionsAndNeverTextProvider() async throws {
        let (store, c) = try await online()
        let id = try await store.createImageChat(params: params, workspaceId: "w")
        XCTAssertEqual(id, "s")
        XCTAssertEqual(c.callsTo(Channels.sessionCreate), [["w"]])
        XCTAssertEqual(c.callsTo(Channels.sessionSetOptions), [["s", params.sessionOptions]])
        XCTAssertTrue(c.callsTo(Channels.chatSend).isEmpty)
        XCTAssertTrue(c.callsTo(Channels.chatGenerateImage).isEmpty)
    }

    func testUnconfirmedImageCreationAndFractionalCFGFailClosed() async throws {
        let (store, c) = try await online()
        c.replies[Channels.sessionSetOptions] = { _ in ["id": "s", "messages": []] }
        do { _ = try await store.createImageChat(params: params, workspaceId: nil); XCTFail("host must confirm image kind and parameters") }
        catch { XCTAssertTrue(error.localizedDescription.contains("did not save image-chat settings")) }
        var fractional = params
        fractional.cfgScale = 4.5
        let settings = fractional.json
        c.replies[Channels.sessionGet] = { _ in ["id": "s", "chatType": "image", "imageParams": settings, "messages": []] }
        let chat = ChatModel(sessionId: "s", store: store)
        await chat.start()?.value
        defer { chat.stop() }
        do { _ = try await chat.send("cat"); XCTFail("fractional proofs are unsupported") }
        catch { XCTAssertTrue(error.localizedDescription.contains("whole-number CFG")) }
        XCTAssertTrue(c.callsTo(Channels.chatGenerateImage).isEmpty)
        XCTAssertTrue(c.callsTo(Channels.chatSend).isEmpty)
    }

    func testGenerationUsesChangeProofAndExactObjectShape() async throws {
        let (store, c) = try await online()
        let chat = ChatModel(sessionId: "s", store: store)
        await chat.start()?.value
        defer { chat.stop() }
        XCTAssertTrue(chat.isImageChat)
        XCTAssertNil(chat.blocked, "does not need a text provider")
        _ = try await chat.send("A plum cat")
        XCTAssertEqual(c.signedTo(Channels.chatGenerateImage), [[params.generation(sessionId: "s", prompt: "A plum cat")]])
        XCTAssertTrue(c.callsTo(Channels.chatSend).isEmpty)
        XCTAssertTrue(c.callsTo(Channels.chatQueue).isEmpty)
        XCTAssertTrue(store.outbox.items.isEmpty)
        XCTAssertFalse(chat.sending)
    }

    func testAttachmentsOfflineOlderHostAndMissingModelsNeverFallBackToText() async throws {
        let (store, c) = try await online()
        let chat = ChatModel(sessionId: "s", store: store)
        await chat.start()?.value
        defer { chat.stop() }
        // Photos are an edit (decision 0069), but one the computer couldn't read never leaves.
        do { _ = try await chat.send("cat", images: ["data:image/png;base64,x"]); XCTFail("unreadable photo refused") }
        catch { XCTAssertTrue(error.localizedDescription.contains("couldn’t be read")) }
        c.replies[Channels.engineModels] = { _ in [["id": "vision", "modality": "vision"]] }
        do { _ = try await chat.send("cat"); XCTFail("vision is not a generator") } catch {}
        c.replies[Channels.appInfo] = { _ in ["version": "old"] }
        await store.refresh()
        XCTAssertFalse(store.imageGeneration)
        do { _ = try await chat.send("cat"); XCTFail("older host") } catch {}
        c.status(RelayStatus(.offline))
        for _ in 0..<20 { await Task.yield() }
        XCTAssertFalse(chat.sendsLater)
        XCTAssertNotNil(chat.blocked)
        do { _ = try await chat.send("cat"); XCTFail("offline") } catch {}
        XCTAssertTrue(store.outbox.items.isEmpty)
        XCTAssertTrue(c.callsTo(Channels.chatSend).isEmpty)
        XCTAssertTrue(c.callsTo(Channels.chatGenerateImage).isEmpty)
    }

    func testImageIntentSurvivesDraftAndOfflineTranscriptAndSummary() throws {
        let d = Draft(text: "cat", imageParams: params)
        XCTAssertEqual(Draft.from(d.json)?.imageParams, params)
        let saved = SavedTranscript(savedAt: 1, session: try XCTUnwrap(Session.from(session)))
        let read = try XCTUnwrap(SavedTranscript.from(saved.json))
        XCTAssertEqual(read.session.chatType, "image")
        XCTAssertEqual(read.session.imageParams, params)
        let summary = try XCTUnwrap(SessionSummary.from(session))
        XCTAssertEqual(summary.chatType, "image")
        XCTAssertEqual(summary.imageParams, params)
        let list = SavedChatList(savedAt: 1, summaries: [summary], folders: [])
        XCTAssertEqual(SavedChatList.from(list.json)?.summaries.first?.chatType, "image")
    }

    func testImageOnlyAssistantReplyUsesExistingPhotoRoute() async throws {
        let (store, c) = try await online()
        c.replies[Channels.sessionGet] = { _ in
            ["id": "s", "chatType": "image", "messages": [["id": "pic", "role": "assistant", "content": "", "images": ["data:image/jpeg;base64,thumbnail"]]]]
        }
        c.replies[Channels.sessionPhoto] = { _ in "data:image/png;base64,full" }
        let chat = ChatModel(sessionId: "s", store: store)
        await chat.start()?.value
        defer { chat.stop() }
        XCTAssertEqual(chat.blocks.map(\.id), ["pic"])
        XCTAssertEqual(chat.photos("pic"), ["data:image/jpeg;base64,thumbnail"])
        let full = try await chat.fullPhoto("pic", 0)
        XCTAssertEqual(full, "data:image/png;base64,full")
        XCTAssertEqual(c.callsTo(Channels.sessionPhoto), [["s", "pic", 0]])
        XCTAssertTrue(c.callsTo("image:fetch").isEmpty)
    }

    func testTextOutboxNeverReplaysAnImageSession() async throws {
        let (store, c) = try await online()
        store.outbox.add(chatId: "s", text: "Keep this image intent")
        await store.outbox.flush()
        XCTAssertTrue(c.callsTo(Channels.chatSend).isEmpty)
        XCTAssertTrue(c.callsTo(Channels.chatQueue).isEmpty)
        XCTAssertTrue(c.callsTo(Channels.chatGenerateImage).isEmpty)
        XCTAssertEqual(store.drafts.draft("s").text, "Keep this image intent")
        XCTAssertTrue(store.drafts.draft("s").refusal?.contains("Image chats require") == true)
    }

    func testGenerationProofIsCryptographicallyVerifiedAndChangeOffRefused() async throws {
        let c = ProofComputer()
        let calls = ChangeCalls(caller: c, signer: SoftwareChangeSigner(), deviceId: "phone-1", computerName: "Studio", now: { c.now })
        let args = [params.generation(sessionId: "s", prompt: "cat")]
        _ = try await calls.call(change: Channels.chatGenerateImage, args)
        XCTAssertEqual(c.proofs(Channels.chatGenerateImage), [true])
        c.changeOn = false
        do { _ = try await calls.call(change: Channels.chatGenerateImage, args); XCTFail("Change off") }
        catch let e as ChangeRefused { XCTAssertEqual(e.code, "change-off") }
    }
}
