import Foundation
import XCTest
@testable import NekkoKit
@testable import NekkoProtocol

/// Photo editing in image chats (decision 0069): photos ride inside the same
/// signed `chat:generateImage` request as `images` and `size`, and Edit sits
/// under each made picture that isn't a clip.
@MainActor
final class ImageChatEditTests: XCTestCase {
    private let params = ImageChatParams(modelId: "flux-local")

    private func online(messages: JSONValue = []) async throws -> (ComputersStore, SigningConnection, ChatModel) {
        var connections: [SigningConnection] = []
        let reply: JSONValue = ["id": "s", "title": "Images", "chatType": "image", "imageParams": params.json, "messages": messages, "queue": []]
        let store = ComputersStore(store: MemoryStore(), makeConnection: { config in
            let c = SigningConnection(config: config)
            c.replies = [
                Channels.appInfo: { _ in ["capabilities": ["imageGeneration": true]] },
                Channels.sessionGet: { _ in reply },
                Channels.engineModels: { _ in [["id": "flux-local", "name": "FLUX", "modality": "image"]] },
                Channels.settingsGet: { _ in [:] },
                Channels.chatPending: { _ in [:] },
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
        let chat = ChatModel(sessionId: "s", store: store)
        await chat.start()?.value
        return (store, connections[0], chat)
    }

    // MARK: Payload

    func testWithoutPhotosNeitherImagesNorSize() {
        let args = params.generation(sessionId: "s", prompt: "A cat")
        XCTAssertNil(args["images"], "never an empty images array: the key is left out")
        XCTAssertNil(args["size"], "never a size without images")
        XCTAssertNil(params.generation(sessionId: "s", prompt: "A cat", images: [])["images"])
        XCTAssertEqual(Set(args.object?.keys.map { $0 } ?? []), ["sessionId", "prompt", "params"])
    }

    func testPhotosAddImagesAndTheFirstPhotosShapeAsSize() throws {
        let portrait = PhotoHeaders.jpeg(3024, 4032)
        let wide = PhotoHeaders.png(1920, 1080)
        let args = params.generation(sessionId: "s", prompt: "Make it night", images: [portrait, wide])
        XCTAssertEqual(args["images"], [.string(portrait), .string(wide)])
        XCTAssertEqual(args["size"], ["width": 896, "height": 1152], "the first photo decides the shape")
        XCTAssertEqual(Set(args["size"]?.object?.keys.map { $0 } ?? []), ["width", "height"])
        XCTAssertEqual(args["params"], params.json, "the chat's own settings are unchanged")
        // At most four photos go.
        let five = (0..<5).map { _ in wide }
        XCTAssertEqual(params.generation(sessionId: "s", prompt: "x", images: five)["images"]?.array?.count, 4)
        // A photo whose size can't be read falls back to the chat's size (the send path refuses it first).
        XCTAssertEqual(params.generation(sessionId: "s", prompt: "x", images: ["data:image/png;base64,x"])["size"], ["width": 1024, "height": 1024])
    }

    func testEditGoesSignedWithImagesAndSizeInsideTheProof() async throws {
        let (store, c, chat) = try await online()
        defer { chat.stop() }
        let photo = PhotoHeaders.png(1920, 1080)
        _ = try await chat.send("Make it night", images: [photo])
        let signed = c.signedTo(Channels.chatGenerateImage)
        XCTAssertEqual(signed, [[params.generation(sessionId: "s", prompt: "Make it night", images: [photo])]])
        XCTAssertEqual(signed.first?.first?["images"], [.string(photo)])
        XCTAssertEqual(signed.first?.first?["size"], ["width": 1344, "height": 768])
        XCTAssertTrue(c.callsTo(Channels.chatSend).isEmpty)
        XCTAssertTrue(store.outbox.items.isEmpty, "image turns never wait in the outbox")
    }

    func testTheProofBindsThePhotosAndSize() async throws {
        let signer = SoftwareChangeSigner()
        let args = [params.generation(sessionId: "s", prompt: "x", images: [PhotoHeaders.png(1920, 1080)])]
        let proof = try await ChangeProof.proof(signer: signer, deviceId: "phone-1", channel: Channels.chatGenerateImage, args: args, ts: 1)
        let sig = try XCTUnwrap(proof.str("sig").flatMap { Data(base64Encoded: $0) })
        let key = try signer.publicKey()
        let text = try ChangeProof.payload(deviceId: "phone-1", channel: Channels.chatGenerateImage, args: args, ts: 1)
        XCTAssertTrue(ChangeProof.verify(publicKey: key, text: text, sig: sig))
        // Another photo, or another size, is not the request that was signed.
        let swapped = [params.generation(sessionId: "s", prompt: "x", images: [PhotoHeaders.png(1080, 1920)])]
        XCTAssertFalse(ChangeProof.verify(publicKey: key, text: try ChangeProof.payload(deviceId: "phone-1", channel: Channels.chatGenerateImage, args: swapped, ts: 1), sig: sig))
        var resized = args[0].object ?? [:]
        resized["size"] = ["width": 2048, "height": 2048]
        XCTAssertFalse(ChangeProof.verify(publicKey: key, text: try ChangeProof.payload(deviceId: "phone-1", channel: Channels.chatGenerateImage, args: [.object(resized)], ts: 1), sig: sig))
    }

    func testPhotosTheGateWouldRefuseNeverLeave() async throws {
        let (_, c, chat) = try await online()
        defer { chat.stop() }
        let ok = PhotoHeaders.jpeg(800, 600)
        let refused: [([String], String)] = [
            (Array(repeating: ok, count: 5), "four photos at most"),
            ([ok, "data:image/gif;base64,R0lGODlh"], "PNG, JPEG and WebP"),
            (["data:image/png;base64,x"], "couldn’t be read"),
            ([ok, "data:image/jpeg;base64," + String(repeating: "A", count: PhotoEdit.maxTotalChars)], "too large to send together"),
        ]
        for (images, reason) in refused {
            do { _ = try await chat.send("x", images: images); XCTFail("refused: \(reason)") }
            catch { XCTAssertTrue(error.localizedDescription.contains(reason), error.localizedDescription) }
        }
        do { _ = try await chat.send("  ", images: [ok]); XCTFail("needs words") }
        catch { XCTAssertTrue(error.localizedDescription.contains("Describe the change")) }
        XCTAssertTrue(c.callsTo(Channels.chatGenerateImage).isEmpty)
        XCTAssertTrue(c.signedTo(Channels.chatGenerateImage).isEmpty)
    }

    // MARK: Edit button

    func testEditSitsUnderMadePicturesNotClipsPromptsOrPlainReplies() async throws {
        let picture = PhotoHeaders.png(1024, 1024)
        let (_, _, chat) = try await online(messages: [
            ["id": "u", "role": "user", "content": "A cat", "images": [.string(picture)]],
            ["id": "made", "role": "assistant", "content": "", "images": [.string(picture)], "generated": ["modelId": "flux-local", "width": 1024, "height": 1024]],
            ["id": "clip", "role": "assistant", "content": "", "images": [.string(picture)], "generated": ["modelId": "wan", "video": ["frames": 49, "fps": 16]]],
            ["id": "noMeta", "role": "assistant", "content": "", "images": [.string(picture)]],
            ["id": "text", "role": "assistant", "content": "Refused: this model can't edit.", "generated": ["modelId": "flux-local"]],
        ])
        defer { chat.stop() }
        XCTAssertTrue(chat.canEdit("made"))
        XCTAssertFalse(chat.canEdit("clip"), "a clip is not offered for editing")
        XCTAssertFalse(chat.canEdit("u"), "the user's own photos are not made pictures")
        XCTAssertFalse(chat.canEdit("noMeta"), "as on the desktop, only replies with `generated`")
        XCTAssertFalse(chat.canEdit("text"), "no picture, no Edit")
        XCTAssertFalse(chat.canEdit("missing"))
    }

    func testNoEditInAnOrdinaryChat() async throws {
        let (store, c, _) = try await online()
        let picture = PhotoHeaders.png(64, 64)
        c.replies[Channels.sessionGet] = { _ in
            ["id": "t", "title": "Text", "messages": [["id": "a", "role": "assistant", "content": "", "images": [.string(picture)], "generated": ["modelId": "m"]]]]
        }
        let chat = ChatModel(sessionId: "t", store: store)
        await chat.start()?.value
        defer { chat.stop() }
        XCTAssertFalse(chat.canEdit("a"))
    }

    func testEditFetchesTheFullSizeAndFallsBackToTheThumbnail() async throws {
        let thumb = PhotoHeaders.jpeg(256, 256)
        let full = PhotoHeaders.png(1024, 1024)
        let (_, c, chat) = try await online(messages: [
            ["id": "made", "role": "assistant", "content": "", "images": [.string(thumb)], "generated": ["modelId": "flux-local"]],
        ])
        defer { chat.stop() }
        c.replies[Channels.sessionPhoto] = { _ in .string(full) }
        let picked = try await chat.pictureToEdit("made", 0)
        XCTAssertEqual(picked, full)
        XCTAssertEqual(c.callsTo(Channels.sessionPhoto), [["s", "made", 0]])
        c.replies[Channels.sessionPhoto] = { _ in throw RelayError("gone", fromComputer: true) }
        let fallback = try await chat.pictureToEdit("made", 0)
        XCTAssertEqual(fallback, thumb)
        c.replies[Channels.sessionPhoto] = { _ in .null }
        let none = try await chat.pictureToEdit("made", 0)
        XCTAssertEqual(none, thumb)
        do { _ = try await chat.pictureToEdit("made", 3); XCTFail("no such picture") } catch {}
        XCTAssertTrue(c.callsTo(Channels.chatGenerateImage).isEmpty, "Edit never sends by itself")
    }
}
