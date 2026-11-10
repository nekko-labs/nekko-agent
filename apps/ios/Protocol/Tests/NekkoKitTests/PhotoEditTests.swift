import Foundation
import XCTest
@testable import NekkoProtocol

/// Tiny image headers: enough bytes for `PhotoEdit.size(of:)`, no pixels.
enum PhotoHeaders {
    static func dataURL(_ type: String, _ bytes: [UInt8]) -> String { "data:\(type);base64," + Data(bytes).base64EncodedString() }

    private static func byte(_ n: Int, _ shift: Int) -> UInt8 { UInt8(truncatingIfNeeded: n >> shift) }
    private static func be16(_ n: Int) -> [UInt8] { [byte(n, 8), byte(n, 0)] }
    private static func be32(_ n: Int) -> [UInt8] { [byte(n, 24), byte(n, 16), byte(n, 8), byte(n, 0)] }
    private static func le16(_ n: Int) -> [UInt8] { [byte(n, 0), byte(n, 8)] }
    private static func le24(_ n: Int) -> [UInt8] { [byte(n, 0), byte(n, 8), byte(n, 16)] }
    private static func le32(_ n: Int) -> [UInt8] { [byte(n, 0), byte(n, 8), byte(n, 16), byte(n, 24)] }
    private static func ascii(_ s: String) -> [UInt8] { Array(s.utf8) }

    private static func riff(_ chunk: String, _ body: [UInt8]) -> String {
        var b: [UInt8] = ascii("RIFF")
        b += [0, 0, 0, 0]
        b += ascii("WEBP")
        b += ascii(chunk)
        b += le32(body.count)
        b += body
        return dataURL("image/webp", b)
    }

    static func png(_ w: Int, _ h: Int) -> String {
        var b: [UInt8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
        b += be32(13)
        b += ascii("IHDR")
        b += be32(w)
        b += be32(h)
        b += [8, 6, 0, 0, 0, 0, 0, 0, 0]
        return dataURL("image/png", b)
    }

    static func jpeg(_ w: Int, _ h: Int) -> String {
        var b: [UInt8] = [0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]
        b += ascii("JFIF")
        b += [0, 1, 1, 0, 0, 1, 0, 1, 0, 0]
        b += [0xFF, 0xC0, 0x00, 0x11, 0x08]
        b += be16(h)
        b += be16(w)
        b += [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xFF, 0xD9]
        return dataURL("image/jpeg", b)
    }

    static func webpVP8X(_ w: Int, _ h: Int) -> String {
        var body: [UInt8] = [0, 0, 0, 0]
        body += le24(w - 1)
        body += le24(h - 1)
        return riff("VP8X", body)
    }

    static func webpVP8L(_ w: Int, _ h: Int) -> String {
        let bits = (w - 1) | (h - 1) << 14
        var body: [UInt8] = [0x2F]
        body += le32(bits)
        body += [0, 0, 0, 0, 0]
        return riff("VP8L", body)
    }

    static func webpVP8(_ w: Int, _ h: Int) -> String {
        var body: [UInt8] = [0, 0, 0, 0x9D, 0x01, 0x2A]
        body += le16(w)
        body += le16(h)
        return riff("VP8 ", body)
    }
}

/// The desktop's photoEdit.ts, ported: the same numbers as photoEditing.test.tsx.
final class PhotoEditTests: XCTestCase {
    private let chosen = PixelSize(width: 1024, height: 1024)

    func testFitScalesDownToTheLongestSideNeverUp() {
        XCTAssertEqual(PhotoEdit.fit(PixelSize(width: 4032, height: 3024)), PixelSize(width: 1536, height: 1152))
        XCTAssertEqual(PhotoEdit.fit(PixelSize(width: 3024, height: 4032)), PixelSize(width: 1152, height: 1536))
        XCTAssertEqual(PhotoEdit.fit(PixelSize(width: 800, height: 600)), PixelSize(width: 800, height: 600))
        // Math.round: a half rounds up, and nothing goes below one pixel.
        XCTAssertEqual(PhotoEdit.fit(PixelSize(width: 3, height: 1), max: 2), PixelSize(width: 2, height: 1))
        XCTAssertEqual(PhotoEdit.fit(PixelSize(width: 10000, height: 1)), PixelSize(width: 1536, height: 1))
    }

    func testEditSizeIsThePhotosShapeAtTheChatsPixelCountInMultiplesOf64() {
        XCTAssertEqual(PhotoEdit.editSize(photo: PixelSize(width: 3024, height: 4032), chosen: chosen), PixelSize(width: 896, height: 1152))
        XCTAssertEqual(PhotoEdit.editSize(photo: PixelSize(width: 1920, height: 1080), chosen: chosen), PixelSize(width: 1344, height: 768))
        XCTAssertEqual(PhotoEdit.editSize(photo: PixelSize(width: 500, height: 500), chosen: chosen), chosen)
        // Extreme shapes stay within what the engine accepts.
        XCTAssertEqual(PhotoEdit.editSize(photo: PixelSize(width: 10000, height: 100), chosen: chosen), PixelSize(width: 2048, height: 256))
        XCTAssertEqual(PhotoEdit.editSize(photo: PixelSize(width: 100, height: 10000), chosen: chosen), PixelSize(width: 256, height: 2048))
        XCTAssertEqual(PhotoEdit.editSize(photo: PixelSize(width: 0, height: 0), chosen: chosen), chosen)
        // A non-square chat size keeps its pixel count: 768x1344 is about 1,032,192 px.
        XCTAssertEqual(PhotoEdit.editSize(photo: PixelSize(width: 1, height: 1), chosen: PixelSize(width: 768, height: 1344)), PixelSize(width: 1024, height: 1024))
        for photo in [PixelSize(width: 4032, height: 3024), PixelSize(width: 1, height: 3), PixelSize(width: 777, height: 333)] {
            let s = PhotoEdit.editSize(photo: photo, chosen: chosen)
            XCTAssertTrue((256...2048).contains(s.width) && s.width % 64 == 0, "\(s)")
            XCTAssertTrue((256...2048).contains(s.height) && s.height % 64 == 0, "\(s)")
        }
    }

    func testHalvesRoundUpLikeMathRound() {
        XCTAssertEqual(PhotoEdit.jsRound(2.5), 3)
        XCTAssertEqual(PhotoEdit.jsRound(2.4999), 2)
        XCTAssertEqual(PhotoEdit.jsRound(0.5), 1)
        // 1088 / 64 = 17 exactly; 1120 / 64 = 17.5 rounds to 18 (1152), as the desktop does.
        XCTAssertEqual(PhotoEdit.editSize(photo: PixelSize(width: 1, height: 1), chosen: PixelSize(width: 1120, height: 1120)), PixelSize(width: 1152, height: 1152))
    }

    func testReadsPNGJPEGAndWebPHeaderSizes() {
        XCTAssertEqual(PhotoEdit.size(of: PhotoHeaders.png(1920, 1080)), PixelSize(width: 1920, height: 1080))
        XCTAssertEqual(PhotoEdit.size(of: PhotoHeaders.jpeg(3024, 4032)), PixelSize(width: 3024, height: 4032))
        XCTAssertEqual(PhotoEdit.size(of: PhotoHeaders.webpVP8X(1536, 1152)), PixelSize(width: 1536, height: 1152))
        XCTAssertEqual(PhotoEdit.size(of: PhotoHeaders.webpVP8L(640, 480)), PixelSize(width: 640, height: 480))
        XCTAssertEqual(PhotoEdit.size(of: PhotoHeaders.webpVP8(320, 240)), PixelSize(width: 320, height: 240))
        XCTAssertNil(PhotoEdit.size(of: "data:image/png;base64,x"))
        XCTAssertNil(PhotoEdit.size(of: PhotoHeaders.png(0, 10)))
        XCTAssertNil(PhotoEdit.size(of: "not a data url"))
    }

    func testTakesPNGJPEGAndWebPOnly() {
        XCTAssertTrue(PhotoEdit.accepts(PhotoHeaders.png(1, 1)))
        XCTAssertTrue(PhotoEdit.accepts(PhotoHeaders.jpeg(1, 1)))
        XCTAssertTrue(PhotoEdit.accepts(PhotoHeaders.webpVP8X(1, 1)))
        XCTAssertFalse(PhotoEdit.accepts("data:image/gif;base64,R0lG"))
        XCTAssertFalse(PhotoEdit.accepts("data:image/heic;base64,AAAA"))
        XCTAssertFalse(PhotoEdit.accepts("https://example.com/a.png"))
        // The phone gate's exact shape: lowercase prefix, non-empty standard base64.
        XCTAssertFalse(PhotoEdit.accepts("data:image/PNG;base64,AAAA"))
        XCTAssertFalse(PhotoEdit.accepts("data:image/png;base64,"))
        XCTAssertFalse(PhotoEdit.accepts("data:image/png;base64,AA AA"))
        XCTAssertFalse(PhotoEdit.accepts("data:image/png;base64,AA\nAA"))
        XCTAssertFalse(PhotoEdit.accepts("data:image/png;base64,AA-_"), "URL-safe base64 is not standard")
        XCTAssertFalse(PhotoEdit.accepts("data:image/png;base64,A==="))
        XCTAssertFalse(PhotoEdit.accepts("data:image/png;base64,=="))
        XCTAssertTrue(PhotoEdit.accepts("data:image/png;base64,AA=="))
        XCTAssertTrue(PhotoEdit.accepts("data:image/jpeg;base64,ab+/9Z=="))
    }

    func testAllPhotosTogetherFitSixMiB() {
        let prefix = "data:image/jpeg;base64,"
        let half = prefix + String(repeating: "A", count: PhotoEdit.maxTotalChars / 2 - prefix.count)
        XCTAssertTrue(PhotoEdit.fitsTotal([half, half]))
        XCTAssertFalse(PhotoEdit.fitsTotal([half, half + "A"]))
        XCTAssertTrue(PhotoEdit.fitsTotal([]))
    }

    func testGeneratedPictureKnowsAClip() {
        XCTAssertEqual(GeneratedPicture.from(["modelId": "m", "width": 1024, "height": 768])?.isClip, false)
        XCTAssertEqual(GeneratedPicture.from(["modelId": "m", "video": ["frames": 49, "fps": 16]])?.isClip, true)
        XCTAssertEqual(GeneratedPicture.from(["modelId": "m", "video": .null])?.isClip, false)
        XCTAssertNil(GeneratedPicture.from(nil))
        let message = ChatMessage.from(["id": "a", "role": "assistant", "images": ["data:image/png;base64,x"], "generated": ["modelId": "m"]])
        XCTAssertNotNil(message?.generated)
        XCTAssertNil(ChatMessage.from(["id": "u", "role": "user", "generated": ["modelId": "m"]])?.generated)
    }
}
