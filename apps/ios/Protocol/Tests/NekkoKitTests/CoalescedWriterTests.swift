import Foundation
import XCTest
@testable import NekkoKit

private final class Log: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String] = []
    private var threads: [Bool] = []
    func add(_ s: String) { lock.withLock { items.append(s); threads.append(Thread.isMainThread) } }
    var entries: [String] { lock.withLock { items } }
    var anyOnMain: Bool { lock.withLock { threads.contains(true) } }
}

/// The saved chat lists and transcripts are written by a coalescing background
/// writer: a burst is one write of the newest value, and never on the main thread (#3386).
@MainActor
final class CoalescedWriterTests: XCTestCase {
    func testABurstIsOneWriteOfTheNewestValueOffTheMainThread() async {
        let log = Log()
        let io = BackgroundIO()
        let w = CoalescedWriter<Int>(delay: 5, io: io) { key, v in log.add("\(key)=\(v)") }
        for v in 1...50 { w.submit("a", v) }
        w.submit("b", 7)
        XCTAssertEqual(w.pending("a"), 50)
        XCTAssertTrue(log.entries.isEmpty, "nothing is written while the burst runs")
        await w.flush()
        XCTAssertEqual(log.entries.sorted(), ["a=50", "b=7"])
        XCTAssertFalse(log.anyOnMain)
        XCTAssertEqual(w.dispatched, 2)
        XCTAssertNil(w.pending("a"))
    }

    func testTheTimerWritesWithoutAFlush() async throws {
        let log = Log()
        let w = CoalescedWriter<Int>(delay: 0.05, io: BackgroundIO()) { key, v in log.add("\(key)=\(v)") }
        w.submit("a", 1)
        try await Task.sleep(nanoseconds: 400_000_000)
        XCTAssertEqual(log.entries, ["a=1"])
        w.submit("a", 2)
        try await Task.sleep(nanoseconds: 400_000_000)
        XCTAssertEqual(log.entries, ["a=1", "a=2"], "a later burst gets its own write")
    }

    func testCancelledValuesAreNeverWritten() async {
        let log = Log()
        let w = CoalescedWriter<Int>(delay: 5, io: BackgroundIO()) { key, v in log.add("\(key)=\(v)") }
        w.submit("a", 1)
        w.submit("b", 2)
        w.cancel("a")
        await w.flush()
        XCTAssertEqual(log.entries, ["b=2"])
        w.submit("c", 3)
        w.cancelAll()
        await w.flush()
        XCTAssertEqual(log.entries, ["b=2"])
    }

    func testAQueuedRemovalRunsAfterTheWriteBeforeIt() async {
        let log = Log()
        let io = BackgroundIO()
        let w = CoalescedWriter<Int>(delay: 5, io: io) { key, v in log.add("write \(key)=\(v)") }
        w.submit("a", 1)
        w.flushNow()
        io.run { log.add("remove a") }
        await io.idle()
        XCTAssertEqual(log.entries, ["write a=1", "remove a"])
    }
}
