import Foundation
import XCTest
@testable import NekkoKit

/// A clock the test moves by hand: a timer's sleep returns only after `fire()`, or
/// at once when its task is cancelled (as `Task.sleep` does). Nothing here depends
/// on how fast the machine is (#3441: the wall-clock version flaked on CI Macs).
@MainActor
final class ManualClock {
    /// Timers waiting on this clock right now.
    private(set) var sleepers = 0
    private var ticks = 0

    func sleep(_ nanoseconds: UInt64) async {
        let started = ticks
        sleepers += 1
        defer { sleepers -= 1 }
        while ticks == started, !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
    }

    /// Every timer waiting now runs out.
    func fire() { ticks += 1 }
}

@MainActor
final class IdleReleaseTests: XCTestCase {
    /// Waits up to five seconds for something the main actor is about to do.
    private func eventually(_ what: String, _ condition: () -> Bool) async {
        let deadline = Date().addingTimeInterval(5)
        while !condition(), Date() < deadline {
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
        XCTAssertTrue(condition(), what)
    }

    func testReleasesAfterTheLastUseEndsAndIdleTimePasses() async {
        let clock = ManualClock()
        var released = 0
        let idle = IdleRelease(after: 60, sleep: { await clock.sleep($0) }) { released += 1 }
        idle.begin()
        XCTAssertEqual(clock.sleepers, 0, "no idle clock while in use")
        idle.end()
        await eventually("the idle clock starts when the use ends") { clock.sleepers == 1 }
        XCTAssertEqual(released, 0, "not before the idle time")
        clock.fire()
        await eventually("released once the idle time passes") { released == 1 }
        XCTAssertEqual(idle.releases, 1)
    }

    func testANewUseRestartsTheClock() async {
        let clock = ManualClock()
        var released = 0
        let idle = IdleRelease(after: 60, sleep: { await clock.sleep($0) }) { released += 1 }
        idle.begin(); idle.end()
        await eventually("the idle clock starts") { clock.sleepers == 1 }
        idle.begin()
        await eventually("a new use stops the clock") { clock.sleepers == 0 }
        clock.fire()
        XCTAssertEqual(released, 0)
        idle.end()
        await eventually("the clock starts again when that use ends") { clock.sleepers == 1 }
        XCTAssertEqual(released, 0)
        clock.fire()
        await eventually("released once, after the last use") { released == 1 }
        XCTAssertEqual(idle.releases, 1)
    }

    func testOverlappingUsesWaitForTheLastOne() async {
        let clock = ManualClock()
        var released = 0
        let idle = IdleRelease(after: 60, sleep: { await clock.sleep($0) }) { released += 1 }
        idle.begin(); idle.begin()
        idle.end()
        XCTAssertEqual(clock.sleepers, 0, "one use is still open")
        idle.end()
        await eventually("the clock starts after the last use") { clock.sleepers == 1 }
        XCTAssertEqual(released, 0)
        clock.fire()
        await eventually("released after the last use") { released == 1 }
    }

    func testReleaseIfIdleSkipsABusyResource() {
        var released = 0
        let idle = IdleRelease(after: 60) { released += 1 }
        idle.begin()
        idle.releaseIfIdle()
        XCTAssertEqual(released, 0)
        idle.end()
        idle.releaseIfIdle()
        XCTAssertEqual(released, 1)
    }
}

final class CachePrunerTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 10_000_000)
    private func file(_ n: String, _ bytes: Int, daysAgo: Double) -> CachePruner.File {
        .init(name: n, bytes: bytes, modified: now.addingTimeInterval(-daysAgo * 86_400))
    }

    func testDropsWhatIsOlderThanTheAge() {
        let files = [file("a.png", 10, daysAgo: 40), file("a.svg", 10, daysAgo: 40), file("b.png", 10, daysAgo: 1), file("b.svg", 10, daysAgo: 1)]
        XCTAssertEqual(CachePruner.plan(files, maxBytes: 1_000, maxAge: 30 * 86_400, now: now), ["a.png", "a.svg"])
    }

    func testDropsTheOldestUntilItFitsAndKeepsPairsTogether() {
        let files = [file("old.png", 60, daysAgo: 5), file("old.svg", 30, daysAgo: 5),
                     file("mid.png", 60, daysAgo: 3), file("mid.svg", 30, daysAgo: 3),
                     file("new.png", 60, daysAgo: 1), file("new.svg", 30, daysAgo: 1)]
        XCTAssertEqual(CachePruner.plan(files, maxBytes: 200, maxAge: 30 * 86_400, now: now), ["old.png", "old.svg"])
        XCTAssertEqual(CachePruner.plan(files, maxBytes: 100, maxAge: 30 * 86_400, now: now), ["mid.png", "mid.svg", "old.png", "old.svg"])
    }

    func testAnEmptyOrSmallCacheIsLeftAlone() {
        XCTAssertTrue(CachePruner.plan([], maxBytes: 10, maxAge: 1, now: now).isEmpty)
        XCTAssertTrue(CachePruner.plan([file("a.png", 5, daysAgo: 0)], maxBytes: 10, maxAge: 86_400, now: now).isEmpty)
    }
}
