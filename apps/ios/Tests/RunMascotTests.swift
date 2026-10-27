import SwiftUI
import UIKit
import XCTest
@testable import NekkoNative

@MainActor
final class RunMascotTests: XCTestCase {
    func testCatAndBadgeWearThePhaseColor() throws {
        let phases: [AgentRunAttributes.Phase] = [.running, .approval, .question, .done, .failed]
        for phase in phases {
            let renderer = ImageRenderer(content: RunMascot(phase: phase, size: 100).padding(10).background(Color.black))
            renderer.scale = 1
            let image = try XCTUnwrap(renderer.cgImage)
            try? UIImage(cgImage: image).pngData()?.write(to: FileManager.default.temporaryDirectory.appendingPathComponent("run-mascot-\(phase.rawValue).png"))
            var bytes = [UInt8](repeating: 0, count: 120 * 120 * 4)
            try bytes.withUnsafeMutableBytes { buffer in
                let context = try XCTUnwrap(CGContext(data: buffer.baseAddress, width: 120, height: 120, bitsPerComponent: 8,
                                                    bytesPerRow: 120 * 4, space: CGColorSpaceCreateDeviceRGB(),
                                                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
                context.draw(image, in: CGRect(x: 0, y: 0, width: 120, height: 120))
            }
            func pixel(_ x: Int, _ y: Int) -> [Int] {
                let i = (y * 120 + x) * 4
                return bytes[i..<i + 3].map(Int.init)
            }
            var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
            UIColor(phase.tint).getRed(&r, green: &g, blue: &b, alpha: &a)
            let tint = [r, g, b].map { Int($0 * 255) }
            func assertTint(_ p: [Int], _ what: String) {
                XCTAssertTrue(zip(p, tint).allSatisfy { abs($0 - $1) <= 12 }, "\(phase) \(what): \(p) vs \(tint)")
            }
            assertTint(pixel(10 + 50, 10 + 40), "cat forehead")
            // Inside the badge disc, clear of its ring and every glyph.
            assertTint(pixel(80, 83), "badge")
        }
    }
}
