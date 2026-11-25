import Foundation
import XCTest
@testable import NekkoKit

@MainActor
final class IdleReleaseTests: XCTestCase {
    func testReleasesAfterTheLastUseEndsAndIdleTimePasses() async throws {
        var released = 0
        let idle = IdleRelease(after: 0.05) { released += 1 }
        idle.begin()
        try await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(released, 0, "never while in use")
        idle.end()
        try await Task.sleep(nanoseconds: 30_000_000)
        XCTAssertEqual(released, 0, "not before the idle time")
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(released, 1)
    }

    func testANewUseRestartsTheClock() async throws {
        var released = 0
        let idle = IdleRelease(after: 0.1) { released += 1 }
        idle.begin(); idle.end()
        try await Task.sleep(nanoseconds: 60_000_000)
        idle.begin()
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(released, 0)
        idle.end()
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(released, 1)
    }

    func testOverlappingUsesWaitForTheLastOne() async throws {
        var released = 0
        let idle = IdleRelease(after: 0.03) { released += 1 }
        idle.begin(); idle.begin()
        idle.end()
        try await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(released, 0)
        idle.end()
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(released, 1)
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
