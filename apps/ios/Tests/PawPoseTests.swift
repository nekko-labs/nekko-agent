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

    func testThePawCurvesOutWithABentElbowAndScoopsTheSpinnerIn() {
        let (shoulder, far, home) = (CGPoint(x: 0, y: 0), CGPoint(x: 0, y: 60), CGPoint(x: 20, y: 5))
        func at(_ pose: PawPose) -> (center: CGPoint, tip: CGPoint, elbow: CGPoint) {
            pose.scoop(shoulder: shoulder, far: far, home: home, side: CGVector(dx: 1, dy: 0), radius: 10)
        }
        XCTAssertEqual(at(PawPose()).tip, shoulder, "tucked in before the reach")
        // It lands on the spinner's outer side.
        XCTAssertEqual(at(PawPose(reach: 1)).tip.x, 8.5, accuracy: 0.001)
        XCTAssertEqual(at(PawPose(reach: 1)).tip.y, 60, accuracy: 0.001)
        // Half way, the paw has swung out past the straight line from the shoulder (x 4.25 there).
        XCTAssertGreaterThan(at(PawPose(reach: 0.5)).tip.x, 8)
        // The elbow bends out to the same side, off the straight arm.
        let held = at(PawPose(reach: 1))
        XCTAssertGreaterThan(held.elbow.x, (shoulder.x + held.tip.x) / 2 + 5)
        // The pull home arcs out too: half way, further out than the straight path (x 10).
        XCTAssertGreaterThan(at(PawPose(reach: 1, spinner: 0.5)).center.x, 20)
        XCTAssertEqual(at(PawPose(reach: 1, spinner: 0)).center, home)
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
