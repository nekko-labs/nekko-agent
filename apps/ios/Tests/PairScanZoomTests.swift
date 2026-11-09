import XCTest
@testable import NekkoNative

final class PairScanZoomTests: XCTestCase {
    /// A recent Pro iPhone: wide field of view, cannot focus closer than 20 cm.
    func testFarFocusingCameraZoomsToTheCap() {
        XCTAssertEqual(PairScanZoom.factor(minimumFocusDistance: 200, fieldOfView: 77, maxZoom: 100), 2)
    }

    func testCloserFocusingCameraZoomsLess() {
        let zoom = PairScanZoom.factor(minimumFocusDistance: 100, fieldOfView: 63, maxZoom: 100)
        XCTAssertEqual(zoom, 1.53, accuracy: 0.01)
    }

    /// iPads and older iPhones focus close enough already.
    func testNearFocusingCameraStaysAtOne() {
        XCTAssertEqual(PairScanZoom.factor(minimumFocusDistance: 50, fieldOfView: 63, maxZoom: 100), 1)
    }

    func testUnknownFocusDistanceStaysAtOne() {
        XCTAssertEqual(PairScanZoom.factor(minimumFocusDistance: -1, fieldOfView: 77, maxZoom: 100), 1)
    }

    func testNeverPastTheFormatsMaximum() {
        XCTAssertEqual(PairScanZoom.factor(minimumFocusDistance: 200, fieldOfView: 77, maxZoom: 1.5), 1.5)
    }
}
