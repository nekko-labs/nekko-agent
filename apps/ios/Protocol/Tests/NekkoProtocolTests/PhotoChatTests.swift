import XCTest
@testable import NekkoProtocol

/// Photo chats on the phone (decision 0069): the turn's arguments, the desktop's
/// photo sizing (photoEdit.ts), and how replies and progress are read.
final class PhotoChatTests: XCTestCase {
    // Headers only: enough for `PhotoEdit.size(of:)`.
    static func png(_ w: Int, _ h: Int) -> String {
        var b: [UInt8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]
        for v in [w, h] { b += [UInt8(v >> 24 & 0xFF), UInt8(v >> 16 & 0xFF), UInt8(v >> 8 & 0xFF), UInt8(v & 0xFF)] }
        b += [8, 6, 0, 0, 0]
        return "data:image/png;base64," + Data(b).base64EncodedString()
    }

    static func jpeg(_ w: Int, _ h: Int) -> String {
        // SOI, an APP0 segment to skip, then SOF0.
        var b: [UInt8] = [0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10] + Array("JFIF".utf8) + [0, 1, 1, 0, 0, 1, 0, 1, 0, 0]
        b += [0xFF, 0xC0, 0x00, 0x11, 0x08, UInt8(h >> 8), UInt8(h & 0xFF), UInt8(w >> 8), UInt8(w & 0xFF), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]
        return "data:image/jpeg;base64," + Data(b).base64EncodedString()
    }

    static func webp(_ w: Int, _ h: Int) -> String {
        var b: [UInt8] = Array("RIFF".utf8) + [0, 0, 0, 0] + Array("WEBPVP8X".utf8) + [10, 0, 0, 0, 0, 0, 0, 0]
        for v in [w - 1, h - 1] { b += [UInt8(v & 0xFF), UInt8(v >> 8 & 0xFF), UInt8(v >> 16 & 0xFF)] }
        return "data:image/webp;base64," + Data(b).base64EncodedString()
    }

    func testReadsAPhotoChatsSettingsWithTheDesktopsDefaults() throws {
        let s = try XCTUnwrap(Session.from(["id": "s", "chatType": "image", "imageParams": ["modelId": "flux", "width": 768, "steps": 8]]))
        XCTAssertTrue(s.isPhotoChat)
        XCTAssertEqual(s.imageParams, ImageParams(modelId: "flux", width: 768, height: 1024, steps: 8, cfgScale: 4.5, seed: -1))
        XCTAssertNil(Session.from(["id": "s", "chatType": "image"])?.imageParams?.modelId, "no model chosen yet")
        XCTAssertNil(ImageParams.from(["width": 512])?.modelId)
        XCTAssertNil(ImageParams.from(["modelId": ""])?.modelId, "an empty id is no model")
        XCTAssertFalse(try XCTUnwrap(Session.from(["id": "s"])).isPhotoChat)
    }

    func testAPictureReplyIsReadAndAClipIsToldApart() throws {
        let picture = try XCTUnwrap(ChatMessage.from(["id": "a", "role": "assistant", "content": "", "images": ["data:image/jpeg;base64,AA"],
                                                       "generated": ["modelId": "flux", "width": 1024, "height": 768, "steps": 28, "cfgScale": 4.5, "seed": 7, "ms": 900]]))
        XCTAssertEqual(picture.generated, GeneratedPicture(modelId: "flux", width: 1024, height: 768, seed: 7, ms: 900, isClip: false))
        let clip = try XCTUnwrap(ChatMessage.from(["id": "a", "role": "assistant", "content": "", "images": [""],
                                                   "generated": ["modelId": "wan", "seed": 1, "ms": 1, "video": ["frames": 33, "fps": 16]]]))
        XCTAssertEqual(clip.generated?.isClip, true)
        XCTAssertNil(ChatMessage.from(["id": "u", "role": "user", "content": "x", "generated": ["seed": 1]])?.generated, "only replies are made pictures")
    }

    func testAPictureOnlyReplyIsATranscriptBlock() {
        let messages = [ChatMessage.from(["id": "u", "role": "user", "content": "a cat"])!,
                        ChatMessage.from(["id": "a", "role": "assistant", "content": "", "images": ["data:image/jpeg;base64,AA"], "generated": ["seed": 1]])!,
                        ChatMessage.from(["id": "e", "role": "assistant", "content": ""])!]
        XCTAssertEqual(Transcript.fromMessages(messages).map(\.id), ["u", "a"], "the picture shows; an empty reply still doesn't")
    }

    func testProgressShowsUntilTheTurnEnds() throws {
        let e = try XCTUnwrap(AgentEvent.from(["type": "image_status", "sessionId": "s", "stage": "loading", "label": "Loading the image model"]))
        XCTAssertEqual(e, .imageStatus(sessionId: "s", stage: "loading", label: "Loading the image model"))
        XCTAssertEqual(e.sessionId, "s")
        var t = Transcript.apply(LiveTurn(), e)
        XCTAssertTrue(t.running)
        XCTAssertEqual(t.status, "Loading the image model")
        t = Transcript.apply(t, .imageStatus(sessionId: "s", stage: "generating", label: "Generating a 1024×1024 image"))
        XCTAssertEqual(t.status, "Generating a 1024×1024 image")
        XCTAssertNil(Transcript.apply(t, .done(sessionId: "s", messageId: "a")).status)
        let failed = Transcript.apply(t, .error(sessionId: "s", message: "Out of memory"))
        XCTAssertNil(failed.status)
        XCTAssertFalse(failed.running)
        XCTAssertEqual(failed.error, "Out of memory")
    }

    func testEditSizeMatchesTheDesktop() {
        let chosen = ImageParams(modelId: "m")
        // photoEdit.ts editSize: the photo's shape at the chat's pixel count, multiples of 64 in 256-2048.
        XCTAssertTrue(PhotoEdit.editSize(photo: PixelSize(width: 3000, height: 4000), chosen: chosen) == (896, 1152))
        XCTAssertTrue(PhotoEdit.editSize(photo: PixelSize(width: 500, height: 500), chosen: chosen) == (1024, 1024))
        XCTAssertTrue(PhotoEdit.editSize(photo: PixelSize(width: 10000, height: 100), chosen: chosen) == (2048, 256))
        XCTAssertTrue(PhotoEdit.editSize(photo: PixelSize(width: 0, height: 10), chosen: chosen) == (1024, 1024))
        XCTAssertEqual(PhotoEdit.fit(PixelSize(width: 4000, height: 3000)), PixelSize(width: 1536, height: 1152))
        XCTAssertEqual(PhotoEdit.fit(PixelSize(width: 800, height: 600)), PixelSize(width: 800, height: 600), "never enlarged")
    }

    func testReadsAPhotosSizeFromItsHeader() {
        XCTAssertEqual(PhotoEdit.size(of: Self.png(1536, 1024)), PixelSize(width: 1536, height: 1024))
        XCTAssertEqual(PhotoEdit.size(of: Self.jpeg(1200, 1600)), PixelSize(width: 1200, height: 1600))
        XCTAssertEqual(PhotoEdit.size(of: Self.webp(640, 480)), PixelSize(width: 640, height: 480))
        XCTAssertNil(PhotoEdit.size(of: "data:image/jpeg;base64,AAAA"))
        XCTAssertNil(PhotoEdit.size(of: "not a data url"))
        XCTAssertTrue(PhotoEdit.accepts(Self.png(1, 1)))
        XCTAssertFalse(PhotoEdit.accepts("data:image/gif;base64,R0lG"))
    }

    func testTheTurnSendsOnlyWhatThePhoneGateAllows() throws {
        let params = ImageParams(modelId: "flux", width: 1024, height: 1024, steps: 28, cfgScale: 4.5, seed: -1)
        let create = try XCTUnwrap(imageTurnOptions(sessionId: "s", prompt: "a cat", params: params))
        // PHONE_IMAGE_TURN_KEYS and PHONE_IMAGE_PARAM_KEYS (packages/shared/src/phone-access.ts).
        XCTAssertEqual(Set(create.object!.keys), ["sessionId", "prompt", "params"])
        XCTAssertEqual(Set(create["params"]!.object!.keys), ["modelId", "width", "height", "steps", "cfgScale", "seed"])
        XCTAssertEqual(create["params"]?["seed"], .int(-1))

        let photos = [Self.jpeg(3000, 4000)] + Array(repeating: Self.png(10, 10), count: 5)
        let edit = try XCTUnwrap(imageTurnOptions(sessionId: "s", prompt: "make it night", params: params, images: photos))
        XCTAssertEqual(Set(edit.object!.keys), ["sessionId", "prompt", "params", "images", "size"])
        XCTAssertEqual(edit["images"]?.array?.count, PhotoEdit.maxPhotos, "four photos at most")
        XCTAssertEqual(edit["size"], ["width": 896, "height": 1152], "the first photo's shape")
        XCTAssertNil(imageTurnOptions(sessionId: "s", prompt: "x", params: ImageParams()), "no model, no turn")
    }
}
