import XCTest
@testable import NekkoKit
@testable import NekkoProtocol

/// A Photo chat's composer on the phone (decision 0069): `chat:generateImage`
/// instead of `chat:send`, its progress, Stop, and Edit under a made picture.
/// Photo headers, as in NekkoProtocolTests' PhotoChatTests (another test target).
private enum PhotoChatTests {
    static func png(_ w: Int, _ h: Int) -> String {
        var b: [UInt8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]
        for v in [w, h] { b += [UInt8(v >> 24 & 0xFF), UInt8(v >> 16 & 0xFF), UInt8(v >> 8 & 0xFF), UInt8(v & 0xFF)] }
        return "data:image/png;base64," + Data(b + [8, 6, 0, 0, 0]).base64EncodedString()
    }

    static func jpeg(_ w: Int, _ h: Int) -> String {
        let b: [UInt8] = [0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x11, 0x08, UInt8(h >> 8), UInt8(h & 0xFF), UInt8(w >> 8), UInt8(w & 0xFF), 3, 1, 0x22, 0, 2, 0x11, 1]
        return "data:image/jpeg;base64," + Data(b).base64EncodedString()
    }
}

@MainActor
final class PhotoChatModelTests: XCTestCase {
    static let picture = "data:image/jpeg;base64,thumb"
    static let made: JSONValue = ["id": "a", "role": "assistant", "content": "", "images": [.string(picture)],
                                  "generated": ["modelId": "flux", "width": 1024, "height": 1024, "seed": 7, "ms": 1200]]
    static let clip: JSONValue = ["id": "c", "role": "assistant", "content": "", "images": [.string(picture)],
                                  "generated": ["modelId": "wan", "seed": 1, "ms": 1, "video": ["frames": 33, "fps": 16]]]

    static func photoChat(model: String? = "flux", messages: [JSONValue] = []) -> JSONValue {
        var params: [String: JSONValue] = ["width": 1024, "height": 1024, "steps": 28, "cfgScale": 4.5, "seed": -1]
        if let model { params["modelId"] = .string(model) }
        return ["id": "s", "title": "Cats", "chatType": "image", "imageParams": .object(params), "messages": .array(messages), "queue": []]
    }

    private func open(_ session: JSONValue, now: Int64 = 5) async throws -> (ChatModel, FakeConnection) {
        let (store, c) = try await ChatModelTests.makeOnline()
        c.replies[Channels.sessionGet] = { _ in session }
        let chat = ChatModel(sessionId: "s", store: store, now: { now })
        await chat.start()?.value
        return (chat, c)
    }

    private func settle() async {
        for _ in 0..<20 { await Task.yield() }
        try? await Task.sleep(nanoseconds: 200_000_000)
        for _ in 0..<20 { await Task.yield() }
    }

    func testWithoutAPictureModelThePhoneSaysWhereToChooseOneAndSendsNothing() async throws {
        let (chat, c) = try await open(Self.photoChat(model: nil))
        defer { chat.stop() }
        XCTAssertTrue(chat.isPhotoChat)
        XCTAssertEqual(chat.blocked, "Choose a picture model for this chat on your computer.")
        do {
            _ = try await chat.send("a cat")
            XCTFail("sent without a model")
        } catch {
            XCTAssertEqual(error.localizedDescription, ChatModel.choosePictureModel)
        }
        XCTAssertTrue(c.callsTo(Channels.chatGenerateImage).isEmpty)
        XCTAssertTrue(c.callsTo(Channels.chatSend).isEmpty)
    }

    func testThePromptMakesAPictureShowsProgressAndReReadsTheReply() async throws {
        let (chat, c) = try await open(Self.photoChat(), now: 9)
        defer { chat.stop() }
        XCTAssertNil(chat.blocked)
        XCTAssertFalse(chat.offersSubagent("a cat"))
        _ = try await chat.send("  a cat in a hat  ")
        XCTAssertTrue(chat.turn.running)
        XCTAssertEqual(chat.blocks.last?.id, "pending-9")
        await settle()
        XCTAssertTrue(c.callsTo(Channels.chatSend).isEmpty, "never a chat turn")
        XCTAssertTrue(c.callsTo(Channels.chatQueue).isEmpty)
        let opts = try XCTUnwrap(c.callsTo(Channels.chatGenerateImage).last?.first)
        XCTAssertEqual(opts, ["sessionId": "s", "prompt": "a cat in a hat",
                              "params": ["modelId": "flux", "width": 1024, "height": 1024, "steps": 28, "cfgScale": 4.5, "seed": -1]])

        c.event(["type": "image_status", "sessionId": "s", "stage": "generating", "label": "Generating a 1024×1024 image"])
        await settle()
        XCTAssertEqual(chat.turn.status, "Generating a 1024×1024 image")

        // Mid-turn the composer neither queues nor starts a second picture.
        do {
            _ = try await chat.send("another")
            XCTFail("a second picture started")
        } catch {
            XCTAssertEqual(error.localizedDescription, ChatModel.waitForPicture)
        }
        chat.abort()
        await settle()
        XCTAssertEqual(c.callsTo(Channels.chatAbort).last, [.string("s")])

        c.replies[Channels.sessionGet] = { _ in
            Self.photoChat(messages: [["id": "u", "role": "user", "content": "a cat in a hat", "createdAt": 9], Self.made])
        }
        c.event(["type": "done", "sessionId": "s", "messageId": "a"])
        await chat.sendTask?.value
        await settle()
        XCTAssertFalse(chat.turn.running)
        XCTAssertNil(chat.turn.status)
        XCTAssertEqual(chat.blocks.map(\.id).last, "a", "the picture is a row of its own")
        XCTAssertEqual(chat.photos("a"), [Self.picture])
        XCTAssertEqual(chat.generated("a")?.seed, 7)
    }

    func testAttachedPhotosAreSentToEditAtTheFirstPhotosShape() async throws {
        let (chat, c) = try await open(Self.photoChat(), now: 3)
        defer { chat.stop() }
        let photo = PhotoChatTests.jpeg(1536, 1152)
        _ = try await chat.send("make it night", images: [photo, "data:image/gif;base64,R0lG"])
        XCTAssertEqual(chat.photos("pending-3"), [photo], "the outgoing bubble shows what is edited")
        await settle()
        let opts = try XCTUnwrap(c.callsTo(Channels.chatGenerateImage).last?.first)
        XCTAssertEqual(opts["images"], [.string(photo)], "only types the computer takes")
        XCTAssertEqual(opts["size"], ["width": 1152, "height": 896])
    }

    func testARefusedPictureGoesBackToTheComposer() async throws {
        let (chat, c) = try await open(Self.photoChat(), now: 4)
        defer { chat.stop() }
        c.replies[Channels.chatGenerateImage] = { _ in throw RelayError("Phone access is off.", fromComputer: true) }
        let photo = PhotoChatTests.png(512, 512)
        _ = try await chat.send("a cat", images: [photo])
        await chat.sendTask?.value
        XCTAssertFalse(chat.turn.running)
        XCTAssertEqual(chat.takeUnsent(), UnsentPrompt(text: "a cat", skill: nil, images: [photo]))
        XCTAssertFalse(chat.blocks.contains { $0.id == "pending-4" })
        XCTAssertNotNil(chat.turn.error)
    }

    func testOfflineAPhotoChatSaysSoInsteadOfWaitingInTheOutbox() async throws {
        let (chat, c) = try await open(Self.photoChat())
        defer { chat.stop() }
        c.status(RelayStatus(.offline))
        await settle()
        XCTAssertFalse(chat.sendsLater)
        XCTAssertNil(chat.offlineNote)
        XCTAssertEqual(chat.blocked, ChatModel.reconnectForPicture)
        do {
            _ = try await chat.send("a cat")
            XCTFail("sent offline")
        } catch {
            XCTAssertEqual(error.localizedDescription, ChatModel.reconnectForPicture)
        }
        XCTAssertTrue(chat.waiting.isEmpty, "nothing waits in the outbox")
    }

    func testEditIsOfferedUnderMadePicturesOnlyAndTakesTheFullSize() async throws {
        let (chat, c) = try await open(Self.photoChat(messages: [["id": "u", "role": "user", "content": "x", "images": [.string(Self.picture)]], Self.made, Self.clip]))
        defer { chat.stop() }
        XCTAssertTrue(chat.canEdit("a"))
        XCTAssertFalse(chat.canEdit("c"), "a clip is not edited")
        XCTAssertFalse(chat.canEdit("u"), "the user's own photo is not a made picture")

        let full = PhotoChatTests.png(1024, 1024)
        c.replies[Channels.sessionPhoto] = { _ in .string(full) }
        let picked = try await chat.pictureToEdit("a", 0)
        XCTAssertEqual(picked, full)
        XCTAssertEqual(c.callsTo(Channels.sessionPhoto).last, [.string("s"), .string("a"), .int(0)])

        // A computer with no full size to send: the small copy is used.
        c.replies[Channels.sessionPhoto] = { _ in .null }
        let small = try await chat.pictureToEdit("a", 0)
        XCTAssertEqual(small, Self.picture)
    }

    func testAnOrdinaryChatStillSendsChatTurns() async throws {
        let (chat, c) = try await open(["id": "s", "title": "T", "messages": [], "queue": []])
        defer { chat.stop() }
        XCTAssertFalse(chat.isPhotoChat)
        _ = try await chat.send("hi")
        await settle()
        // (The outbox may send it again with the same id, since this fake never lists it.)
        XCTAssertFalse(c.callsTo(Channels.chatSend).isEmpty)
        XCTAssertTrue(c.callsTo(Channels.chatGenerateImage).isEmpty)
    }
}
