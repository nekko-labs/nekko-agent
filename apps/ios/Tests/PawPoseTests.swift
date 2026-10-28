import XCTest
@testable import NekkoNative

final class PawPoseTests: XCTestCase {
    func testShockedBeatThenReachAndHold() {
        // Still while shocked, then out to the spinner, and it stays there.
        XCTAssertEqual(PawPose.refreshing(PawPose.reachDelay, reduceMotion: false).reach, 0)
        XCTAssertGreaterThan(PawPose.refreshing(PawPose.reachDelay + 0.1, reduceMotion: false).reach, 0.3)
        XCTAssertEqual(PawPose.refreshing(PawPose.reachEnd, reduceMotion: false), PawPose(reach: 1))
        XCTAssertEqual(PawPose.refreshing(5, reduceMotion: false), PawPose(reach: 1))
    }

    func testPullsTheSpinnerHomeThenLetsItGo() {
        XCTAssertEqual(PawPose.ending(0, reduceMotion: false), PawPose(reach: 1))
        XCTAssertEqual(PawPose.ending(PawPose.pullDuration, reduceMotion: false).spinner, 0)
        XCTAssertEqual(PawPose.ending(PawPose.pullDuration, reduceMotion: false).spinnerOpacity, 1)
        XCTAssertEqual(PawPose.ending(PawPose.pullDuration + PawPose.smileBeat, reduceMotion: false).spinnerOpacity, 0)
    }

    func testFacesFollowTheRefresh() {
        let pull = PawPull()
        XCTAssertFalse(pull.shocked)
        pull.refreshStart = Date()
        XCTAssertTrue(pull.shocked)
        pull.smiling = true
        XCTAssertFalse(pull.shocked)
    }

    func testReduceMotionStaysStill() {
        XCTAssertEqual(PawPose.refreshing(0.3, reduceMotion: true), PawPose())
        XCTAssertEqual(PawPose.ending(0.2, reduceMotion: true), PawPose())
    }
}
