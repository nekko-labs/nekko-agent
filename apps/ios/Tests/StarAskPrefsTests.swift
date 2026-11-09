import XCTest
import NekkoKit
@testable import NekkoNative

/// The GitHub star ask as this iPhone keeps it (Prefs, UserDefaults `starAsk`).
@MainActor
final class StarAskPrefsTests: XCTestCase {
    private func defaults() throws -> (UserDefaults, String) {
        let suite = "star-ask-\(UUID().uuidString)"
        return (try XCTUnwrap(UserDefaults(suiteName: suite)), suite)
    }

    func testCountsAndAsksAtTheTenthAndFiftiethReply() throws {
        let (d, suite) = try defaults()
        defer { d.removePersistentDomain(forName: suite) }
        let prefs = Prefs(defaults: d)
        XCTAssertEqual(prefs.starAsk, StarAsk(), "a fresh install starts at zero")
        var shown: [Int] = []
        for n in 1...120 {
            if prefs.starAskAfterReply() { shown.append(n) }
        }
        XCTAssertEqual(shown, [10, 50])
        XCTAssertEqual(Prefs(defaults: d).starAsk, StarAsk(prompts: 120, asked: 2), "kept across launches")
    }

    func testStopIsKept() throws {
        let (d, suite) = try defaults()
        defer { d.removePersistentDomain(forName: suite) }
        let prefs = Prefs(defaults: d)
        for _ in 1...10 { _ = prefs.starAskAfterReply() }
        prefs.stopStarAsk()
        let again = Prefs(defaults: d)
        XCTAssertTrue(again.starAsk.stopped)
        var asked = false
        for _ in 1...60 { asked = again.starAskAfterReply() || asked }
        XCTAssertFalse(asked, "never asked again")
    }

    func testAMalformedValueIsAFreshStart() throws {
        let (d, suite) = try defaults()
        defer { d.removePersistentDomain(forName: suite) }
        d.set("{not json", forKey: StarAsk.key)
        XCTAssertEqual(Prefs(defaults: d).starAsk, StarAsk())
        d.set(42, forKey: StarAsk.key)
        XCTAssertEqual(Prefs(defaults: d).starAsk, StarAsk())
        d.set(#"{"prompts":9,"asked":0}"#, forKey: StarAsk.key)
        XCTAssertTrue(Prefs(defaults: d).starAskAfterReply(), "a stored count carries on")
    }
}
