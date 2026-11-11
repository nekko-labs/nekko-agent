import SwiftUI
import XCTest
@testable import NekkoNative

@MainActor
final class SeasonalDecorationTests: XCTestCase {
    func testOnlySeasonalPresetsWearHats() {
        XCTAssertEqual(SeasonalDecoration(preset: nil), .none)
        for preset in ThemePreset.all {
            let expected: SeasonalDecoration = preset.id == "winter" ? .winter : preset.id == "autumn" ? .spooky : .none
            XCTAssertEqual(SeasonalDecoration(preset: preset), expected, preset.id)
        }
    }

    func testEightDeterministicFlakesWithOneCat() {
        XCTAssertEqual(WinterFlakes.count, 8)
        XCTAssertTrue((0..<WinterFlakes.count).contains(WinterFlakes.catIndex))
        XCTAssertEqual((0..<WinterFlakes.count).filter { $0 == WinterFlakes.catIndex }.count, 1)
        for index in 0..<WinterFlakes.count {
            let start = WinterFlakes.position(index, seconds: 0)
            XCTAssertEqual(start, WinterFlakes.position(index, seconds: 0))
            XCTAssertNotEqual(start, WinterFlakes.position(index, seconds: 3))
            for seconds in [0.0, 3, 30, 300, 3_600] {
                let point = WinterFlakes.position(index, seconds: seconds)
                XCTAssertTrue((0...1).contains(point.x))
                XCTAssertTrue((0..<1).contains(point.y))
            }
        }
    }

    func testNoHatForOtherThemesAndSeasonalHatsRender() throws {
        for decoration in [SeasonalDecoration.none, .winter, .spooky] {
            let renderer = ImageRenderer(content: MascotHat(decoration: decoration).frame(width: 320, height: 320))
            renderer.scale = 1
            let image = try XCTUnwrap(renderer.cgImage)
            var bytes = [UInt8](repeating: 0, count: 320 * 320 * 4)
            try bytes.withUnsafeMutableBytes { buffer in
                let context = try XCTUnwrap(CGContext(data: buffer.baseAddress, width: 320, height: 320, bitsPerComponent: 8,
                                                     bytesPerRow: 320 * 4, space: CGColorSpaceCreateDeviceRGB(),
                                                     bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
                context.draw(image, in: CGRect(x: 0, y: 0, width: 320, height: 320))
            }
            let painted = stride(from: 3, to: bytes.count, by: 4).contains { bytes[$0] > 0 }
            XCTAssertEqual(painted, decoration != .none)
            // Hats stop above the eyes at grid y=14 and do not cover the greeting face.
            XCTAssertTrue(stride(from: 140 * 320 * 4 + 3, to: bytes.count, by: 4).allSatisfy { bytes[$0] == 0 })
        }
    }
}
