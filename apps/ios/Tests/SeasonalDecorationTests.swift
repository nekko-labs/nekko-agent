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

    func testTenSlowLargeFlakesInEightDesignsAndNoCat() {
        XCTAssertEqual(WinterFlakes.count, 10)
        XCTAssertEqual(WinterFlakes.typeCount, 8)
        for type in 0..<WinterFlakes.typeCount { XCTAssertFalse(WinterFlakes.path(type).isEmpty) }
        var types = Set<Int>()
        for seed: UInt64 in [1, 42, 0xDEAD_BEEF] {
            for index in 0..<WinterFlakes.count {
                let start = WinterFlakes.flake(index, seconds: 0, seed: seed)
                XCTAssertEqual(start, WinterFlakes.flake(index, seconds: 0, seed: seed))
                XCTAssertNotEqual(start.position, WinterFlakes.flake(index, seconds: 3, seed: seed).position)
                // Slow: no flake moves more than 1/48 of the screen height per second.
                let next = WinterFlakes.flake(index, seconds: 1, seed: seed)
                if next.position.y > start.position.y { XCTAssertLessThanOrEqual(next.position.y - start.position.y, 1.0 / 48 + 1e-9) }
                for seconds in [0.0, 3, 30, 300, 3_600] {
                    let flake = WinterFlakes.flake(index, seconds: seconds, seed: seed)
                    XCTAssertTrue((0...1).contains(flake.position.x))
                    XCTAssertTrue((0..<1).contains(flake.position.y))
                    XCTAssertTrue(WinterFlakes.radius.contains(flake.radius))
                    types.insert(flake.type)
                }
            }
        }
        XCTAssertEqual(types, Set(0..<8))
    }

    func testHashMatchesAndroid() {
        XCTAssertEqual(WinterFlakes.unit(42, 3, 7, 4), 0.20620949912738473, accuracy: 1e-12)
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
