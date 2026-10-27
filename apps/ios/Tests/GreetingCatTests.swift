import SwiftUI
import XCTest
@testable import NekkoNative

@MainActor
final class GreetingCatTests: XCTestCase {
    func testFaceStopsAtEdgeAndOnlyDownwardPawsHangBelowIt() throws {
        let palette = Palette.make(dark: true, accent: nil)
        let renderer = ImageRenderer(content: GreetingCat().frame(width: 320, height: 300).environment(\.palette, palette))
        renderer.scale = 1
        let image = try XCTUnwrap(renderer.cgImage)
        // Normalize to RGBA, independent of the renderer's native bitmap format.
        var bytes = [UInt8](repeating: 0, count: 320 * 300 * 4)
        try bytes.withUnsafeMutableBytes { buffer in
            let context = try XCTUnwrap(CGContext(data: buffer.baseAddress, width: 320, height: 300, bitsPerComponent: 8,
                                                bytesPerRow: 320 * 4, space: CGColorSpaceCreateDeviceRGB(),
                                                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
            context.draw(image, in: CGRect(x: 0, y: 0, width: 320, height: 300))
        }
        func pixel(_ x: Int, _ y: Int) -> [UInt8] {
            Array(bytes[((y * 320 + x) * 4)..<((y * 320 + x) * 4 + 4)])
        }
        // Face fill continues above the edge, without an accent-colored nose.
        XCTAssertEqual(pixel(155, 205), pixel(155, 215))
        XCTAssertGreaterThan(pixel(155, 245)[3], 0)
        XCTAssertEqual(pixel(155, 255)[3], 0, "Chin must be hidden below y=25")
        // The paw outline and toes are below the edge, not at the paw's top.
        for x in [87, 217] {
            XCTAssertGreaterThan(pixel(x, 262)[0], pixel(x, 242)[0], "Toe marks face down")
            XCTAssertGreaterThan(pixel(x, 275)[0], 200, "The bottom of each paw is ink")
        }
    }
}
