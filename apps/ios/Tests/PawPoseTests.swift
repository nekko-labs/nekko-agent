import XCTest
@testable import NekkoNative

final class PawPoseTests: XCTestCase {
    func testExclamationThenAQuickGrabAndStraightIntoThePull() {
        // The "!" while the paw waits, gone as it moves.
        XCTAssertEqual(PawPose.refreshing(0, reduceMotion: false), PawPose(alarm: true))
        XCTAssertFalse(PawPose.refreshing(PawPose.reachDelay, reduceMotion: false).alarm)
        let reached = PawPose.reachDelay + PawPose.reachDuration
        XCTAssertGreaterThan(PawPose.refreshing(PawPose.reachDelay + PawPose.reachDuration / 2, reduceMotion: false).reach, 0.5)
        // No hold on the spinner: the pull starts the moment the paw is there.
        XCTAssertEqual(PawPose.refreshing(reached, reduceMotion: false), PawPose(reach: 1))
        XCTAssertLessThan(PawPose.refreshing(reached + 0.05, reduceMotion: false).spinner, 1)
        XCTAssertEqual(PawPose.refreshing(PawPose.pullEnd + 0.01, reduceMotion: false), PawPose(reach: 1, spinner: 0))
        // A long reload keeps it home by the cat.
        XCTAssertEqual(PawPose.refreshing(5, reduceMotion: false), PawPose(reach: 1, spinner: 0))
        XCTAssertLessThan(PawPose.pullEnd, 0.8, "a quick grab and pull")
    }

    func testOnceTheReloadIsDoneTheSpinnerFadesAndThePawGoesBack() {
        XCTAssertEqual(PawPose.ending(0, reduceMotion: false), PawPose(reach: 1, spinner: 0))
        XCTAssertEqual(PawPose.ending(PawPose.smileBeat, reduceMotion: false), PawPose(reach: 0, spinner: 0, spinnerOpacity: 0))
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

    @MainActor func testFacesFollowTheRefresh() {
        let pull = PawPull()
        XCTAssertFalse(pull.shocked)
        pull.refreshStart = Date()
        XCTAssertTrue(pull.shocked)
        pull.smiling = true
        XCTAssertFalse(pull.shocked)
    }

    func testReduceMotionStaysStill() {
        XCTAssertEqual(PawPose.refreshing(0, reduceMotion: true), PawPose(alarm: true))
        XCTAssertEqual(PawPose.refreshing(0.6, reduceMotion: true), PawPose())
        XCTAssertEqual(PawPose.ending(0.2, reduceMotion: true), PawPose())
    }
}
