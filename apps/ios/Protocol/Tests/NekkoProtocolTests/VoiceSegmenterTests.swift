import XCTest
@testable import NekkoProtocol

final class VoiceSegmenterTests: XCTestCase {
    private let rate = 16_000.0
    private func tone(_ seconds: Double) -> [Float] { (0..<Int(seconds * rate)).map { 0.5 * sin(Float($0) * 0.1) } }
    private func quiet(_ seconds: Double) -> [Float] { [Float](repeating: 0, count: Int(seconds * rate)) }
    private func segmenter() -> VoiceSegmenter { VoiceSegmenter(sampleRate: rate, silenceSeconds: 1.2, threshold: 0.02) }

    func testSilenceAfterSpeechEndsASegment() {
        var s = segmenter()
        XCTAssertNil(s.feed(tone(1)))
        XCTAssertNil(s.feed(quiet(1.1)))
        XCTAssertEqual(try XCTUnwrap(s.feed(quiet(0.2))).count, Int(2.3 * rate), accuracy: Int(0.1 * rate))
        XCTAssertNil(s.feed(quiet(2)))
    }

    func testChunkSizeDoesNotMoveTheCut() {
        var s = segmenter()
        let all = tone(1) + quiet(1.3)
        var segments: [[Float]] = []
        for start in stride(from: 0, to: all.count, by: 441) { if let seg = s.feed(Array(all[start..<min(start + 441, all.count)])) { segments.append(seg) } }
        XCTAssertEqual(segments.count, 1)
    }

    func testCutsAtMaxSeconds() throws {
        var s = segmenter()
        let seg = try XCTUnwrap(s.feed(tone(31)))
        XCTAssertEqual(seg.count, Int(30 * rate))
        XCTAssertNil(s.feed(quiet(0.1)))
    }

    func testDropsAShortBlip() {
        var s = segmenter()
        XCTAssertNil(s.feed(tone(0.1)))
        XCTAssertNil(s.feed(quiet(1.5)))
    }

    func testKeepsOnlyAPreRollBeforeSpeech() throws {
        var s = segmenter()
        XCTAssertNil(s.feed(quiet(5)))
        XCTAssertNil(s.feed(tone(1)))
        let seg = try XCTUnwrap(s.feed(quiet(1.3)))
        XCTAssertEqual(seg.count, Int(2.6 * rate), accuracy: Int(0.1 * rate))
    }

    func testSeveralSegmentsInOneFeedAreDrainedByFlush() throws {
        var s = segmenter()
        let first = try XCTUnwrap(s.feed(tone(1) + quiet(1.5) + tone(1) + quiet(1.5)))
        XCTAssertEqual(first.count, Int(2.3 * rate))
        XCTAssertEqual(Array(first[0..<Int(rate)]), tone(1))
        XCTAssertEqual(Array(first[Int(rate)...]), quiet(1.3))
        let second = try XCTUnwrap(s.flush())
        XCTAssertEqual(second.count, Int(2.5 * rate))
        XCTAssertEqual(Array(second[0..<Int(0.2 * rate)]), quiet(0.2))
        XCTAssertEqual(Array(second[Int(0.2 * rate)..<Int(1.2 * rate)]), tone(1))
        XCTAssertEqual(Array(second[Int(1.2 * rate)...]), quiet(1.3))
        XCTAssertNil(s.flush())
    }

    func testFlushReturnsTheUtteranceInProgress() throws {
        var s = segmenter()
        XCTAssertNil(s.feed(tone(0.55) + quiet(0.3)))
        XCTAssertEqual(try XCTUnwrap(s.flush()).count, Int(0.85 * rate))
        XCTAssertNil(s.flush())
    }

    func testFlushDropsABlipAndEmptyState() {
        var s = segmenter()
        XCTAssertNil(s.flush())
        XCTAssertNil(s.feed(tone(0.1)))
        XCTAssertNil(s.flush())
    }
}
