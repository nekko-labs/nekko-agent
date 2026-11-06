import XCTest
import UIKit
@testable import NekkoNative

@MainActor
final class PhotoPreviewTests: XCTestCase {
    func testComposerPreviewIsBoundedAndKeepsAspectRatio() throws {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let image = UIGraphicsImageRenderer(size: CGSize(width: 1600, height: 900), format: format).image { ctx in
            UIColor.systemTeal.setFill()
            ctx.fill(CGRect(x: 0, y: 0, width: 1600, height: 900))
        }
        let source = "data:image/jpeg;base64," + (try XCTUnwrap(image.jpegData(compressionQuality: 0.8))).base64EncodedString()
        let preview = try XCTUnwrap(DataURLImage.thumbnail(source))
        XCTAssertEqual(preview.size.width, 240)
        XCTAssertEqual(preview.size.height, 135)
        XCTAssertEqual(DataURLImage.decode(source)?.size.width, 1600, "the viewer still has the original")
    }

    func testUnreadableAndWithheldPhotosDoNotDecodeOrFetch() {
        for source in ["", "not an image", "data:image/png;base64,bm90IGFuIGltYWdl", "data:image/png;base64,???", "https://example.com/photo.jpg"] {
            XCTAssertNil(DataURLImage.thumbnail(source))
        }
    }
}
