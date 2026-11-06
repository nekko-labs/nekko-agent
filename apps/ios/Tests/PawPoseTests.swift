import XCTest
@testable import NekkoNative

final class PawPoseTests: XCTestCase {
    func testLoadingNeverGrabsEarly() {
        XCTAssertEqual(PawPose.refreshing(0, reduceMotion: false), PawPose(alarm: true))
        for t in [PawPose.reachDelay, 1, 5, 60] {
            XCTAssertEqual(PawPose.refreshing(t, reduceMotion: false), PawPose())
        }
    }

    func testCompletionReachesThenScoopsWithoutPausing() {
        XCTAssertEqual(PawPose.grabbing(0, reduceMotion: false), PawPose())
        XCTAssertGreaterThan(PawPose.grabbing(PawPose.reachDuration / 2, reduceMotion: false).reach, 0.5)
        XCTAssertEqual(PawPose.grabbing(PawPose.reachDuration, reduceMotion: false), PawPose(reach: 1))
        XCTAssertLessThan(PawPose.grabbing(PawPose.reachDuration + 0.05, reduceMotion: false).spinner, 1)
        XCTAssertEqual(PawPose.grabbing(PawPose.pullEnd, reduceMotion: false), PawPose(reach: 1, spinner: 0))
    }

    @MainActor func testSlowReloadAndDuplicateRefresh() async throws {
        let pull = PawPull()
        var calls = 0
        let task = Task { await pull.reload { calls += 1; try? await Task.sleep(for: .milliseconds(500)) } }
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertNotNil(pull.refreshStart)
        XCTAssertNil(pull.grabStart, "the action has not completed")
        XCTAssertEqual(pull.pose(at: Date().addingTimeInterval(60)).reach, 0)
        XCTAssertNotEqual(pull.turn(at: Date()), pull.turn(at: Date().addingTimeInterval(0.1)))
        await pull.reload { calls += 1 }
        XCTAssertEqual(calls, 1, "a second gesture or menu action must not overlap")
        await task.value
        XCTAssertFalse(pull.animating)
        XCTAssertTrue(pull.smiling)
    }

    @MainActor func testCancellationDoesNotScoopOrSmile() async throws {
        let pull = PawPull()
        let task = Task { await pull.reload { try? await Task.sleep(for: .seconds(10)) } }
        try await Task.sleep(for: .milliseconds(50))
        task.cancel()
        await task.value
        XCTAssertFalse(pull.animating)
        XCTAssertFalse(pull.smiling)
        XCTAssertNil(pull.grabStart)
        XCTAssertEqual(pull.progress, 0)
    }

    func testBottomEdgeUsesInsetsAndWorksWithShortOrEmptyChats() {
        func progress(_ offset: CGFloat, content: CGFloat = 1200) -> CGFloat {
            PawBottomEdge.progress(offset: offset, content: content, viewport: 600, top: 100, bottom: 40)
        }
        XCTAssertEqual(progress(-100), 0, "top pull cannot refresh a chat")
        XCTAssertEqual(progress(500), 0, "scrolling history is not a pull")
        XCTAssertEqual(progress(640), 0)
        XCTAssertEqual(progress(680), 0.5)
        XCTAssertEqual(progress(720), 1)
        XCTAssertEqual(progress(900), 1)
        XCTAssertEqual(progress(-100, content: 0), 0)
        XCTAssertEqual(progress(-20, content: 0), 1)
        XCTAssertEqual(progress(-20, content: 300), 1)
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
        XCTAssertEqual(PawPose.grabbing(0.2, reduceMotion: true), PawPose())
        XCTAssertEqual(PawPose.ending(0.2, reduceMotion: true), PawPose())
    }
}
