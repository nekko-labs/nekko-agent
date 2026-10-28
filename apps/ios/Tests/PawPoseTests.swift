import XCTest
@testable import NekkoNative

final class PawPoseTests: XCTestCase {
    func testTwoSlapsThenHold() {
        let reach = stride(from: 0.0, through: 0.6, by: 0.01).map { PawPose.refreshing($0, reduceMotion: false).reach }
        // Out, back to the cat, out again: two separate slaps.
        let rises = zip(reach, reach.dropFirst()).filter { $0 == 0 && $1 > 0 }.count
        XCTAssertEqual(rises, 2)
        XCTAssertEqual(PawPose.refreshing(0.15, reduceMotion: false).reach, 1)
        XCTAssertGreaterThan(PawPose.refreshing(0.16, reduceMotion: false).squash, 0.5)
        XCTAssertGreaterThan(PawPose.refreshing(0.41, reduceMotion: false).squash, 0.5)
        XCTAssertEqual(PawPose.refreshing(2, reduceMotion: false), PawPose(reach: 1, spinnerX: 1, squash: 0))
    }

    func testPullsTheSpinnerHomeAsThePageCloses() {
        XCTAssertEqual(PawPose.ending(0, reduceMotion: false).spinnerX, 1)
        XCTAssertEqual(PawPose.ending(PawPose.pullDuration, reduceMotion: false).spinnerX, 0)
        XCTAssertEqual(PawPose.ending(0.2, reduceMotion: false).reach, 1)
    }

    func testReduceMotionStaysStill() {
        XCTAssertEqual(PawPose.refreshing(0.15, reduceMotion: true), PawPose())
        XCTAssertEqual(PawPose.ending(0.2, reduceMotion: true), PawPose())
    }
}
