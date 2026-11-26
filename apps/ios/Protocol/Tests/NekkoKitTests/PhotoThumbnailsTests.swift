#if canImport(ImageIO) && canImport(CoreGraphics)
import CoreGraphics
import Foundation
import ImageIO
import XCTest
@testable import NekkoKit

final class PhotoThumbnailsTests: XCTestCase {
    /// A solid-colour PNG data URL of the given size.
    private func photo(_ width: Int, _ height: Int, tint: UInt8 = 0x40) -> String {
        let space = CGColorSpaceCreateDeviceRGB()
        let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                            space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.setFillColor(red: CGFloat(tint) / 255, green: 0.5, blue: 0.5, alpha: 1)
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let data = NSMutableData()
        let dest = CGImageDestinationCreateWithData(data, "public.png" as CFString, 1, nil)!
        CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
        CGImageDestinationFinalize(dest)
        return "data:image/png;base64," + (data as Data).base64EncodedString()
    }

    func testThumbnailIsBoundedAndKeepsAspectRatio() throws {
        let image = try XCTUnwrap(PhotoThumbnails.decode(photo(1600, 900)))
        XCTAssertEqual(image.width, 240)
        XCTAssertEqual(image.height, 135)
    }

    func testUnreadableAndWithheldPhotosDecodeToNothing() {
        for source in ["", "not an image", "data:image/png;base64,bm90IGFuIGltYWdl", "data:image/png;base64,???", "https://example.com/photo.jpg"] {
            XCTAssertNil(PhotoThumbnails.decode(source))
        }
    }

    func testLoadDecodesOnceThenServesTheCache() async throws {
        let cache = PhotoThumbnails(countLimit: 10, byteLimit: 1 << 24)
        let source = photo(800, 600)
        XCTAssertNil(cache.cached(source), "nothing is cached before the first load")
        let first = await cache.load(source)
        XCTAssertNotNil(first)
        let hit = try XCTUnwrap(cache.cached(source))
        XCTAssertTrue(hit === first, "the second read is the same decoded image, not a new decode")
    }

    func testAnUnreadablePhotoIsRememberedSoItIsNotDecodedAgain() async {
        let cache = PhotoThumbnails(countLimit: 10, byteLimit: 1 << 24)
        let image = await cache.load("")
        XCTAssertNil(image)
        let remembered = cache.cached("")
        XCTAssertNotNil(remembered, "tried once")
        XCTAssertNil(remembered!, "and there is nothing to show")
    }

    func testTheCacheIsBounded() async {
        let cache = PhotoThumbnails(countLimit: 3, byteLimit: 1 << 24)
        let sources = (0..<8).map { photo(400, 300, tint: UInt8($0 * 20)) }
        for s in sources { _ = await cache.load(s) }
        let kept = sources.filter { cache.cached($0) != nil }.count
        XCTAssertLessThanOrEqual(kept, 3)
    }

    /// What the main thread paid per photo before: a full decode on every
    /// evaluation of the row (a 1200x900 photo, about what the computer sends).
    func testMeasureDecodeOnEveryEvaluation() {
        let source = photo(1200, 900)
        measure(metrics: [XCTClockMetric()]) { for _ in 0..<20 { _ = PhotoThumbnails.decode(source) } }
    }

    /// What it pays after: a cache lookup (the decode ran once, off the main thread).
    func testMeasureCacheLookup() async throws {
        let source = photo(1200, 900)
        let cache = PhotoThumbnails(countLimit: 10, byteLimit: 1 << 24)
        _ = await cache.load(source)
        measure(metrics: [XCTClockMetric()]) { for _ in 0..<20 { _ = cache.cached(source) } }
    }
}
#endif
