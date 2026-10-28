import XCTest
@testable import NekkoNative

@MainActor
final class SimpleModeTests: XCTestCase {
    func testDefaultsShowOnlyTheModelInSimpleAndEverythingInExpert() {
        let simple = SimpleMode.items.filter { SimpleMode.shown($0.id, expert: false, [:]) }.map(\.id)
        XCTAssertEqual(simple, ["model"])
        XCTAssertTrue(SimpleMode.items.allSatisfy { SimpleMode.shown($0.id, expert: true, [:]) })
    }

    func testEachChoiceInEachMode() {
        XCTAssertTrue(SimpleMode.shown("effort", expert: false, ["effort": .show]))
        XCTAssertTrue(SimpleMode.shown("effort", expert: true, ["effort": .show]))
        XCTAssertFalse(SimpleMode.shown("model", expert: false, ["model": .expert]))
        XCTAssertTrue(SimpleMode.shown("model", expert: true, ["model": .expert]))
        XCTAssertFalse(SimpleMode.shown("context", expert: false, ["context": .hide]))
        XCTAssertFalse(SimpleMode.shown("context", expert: true, ["context": .hide]))
    }

    func testUnknownIdsAlwaysShow() {
        XCTAssertTrue(SimpleMode.shown("not-a-control", expert: false, ["not-a-control": .hide]))
        XCTAssertEqual(SimpleMode.visibility("not-a-control", [:]), .show)
    }

    func testParseIgnoresBadJsonUnknownIdsBadValuesAndDefaults() {
        XCTAssertEqual(SimpleMode.parse("{not json"), [:])
        XCTAssertEqual(SimpleMode.parse("[\"effort\"]"), [:])
        XCTAssertEqual(SimpleMode.parse(nil), [:])
        XCTAssertEqual(SimpleMode.parse(#"{"effort":"show","nope":"hide","context":"sometimes","model":"show","terminal":3}"#),
                       ["effort": .show])
    }

    func testEncodeKeepsOnlyChangesAndRoundTripsThroughPrefs() throws {
        XCTAssertEqual(SimpleMode.encode(["effort": .show, "model": .show, "nope": .hide]), #"{"effort":"show"}"#)
        let suite = "simple-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let prefs = Prefs(defaults: defaults)
        XCTAssertFalse(prefs.expertMode, "a new install starts in Simple")
        XCTAssertFalse(prefs.shows("context"))
        prefs.simpleChoices["context"] = .show
        prefs.simpleChoices["model"] = .hide
        let again = Prefs(defaults: defaults)
        XCTAssertEqual(again.simpleChoices, ["context": .show, "model": .hide])
        XCTAssertTrue(again.shows("context"))
        XCTAssertFalse(again.shows("model"))
    }

    func testIdsMatchThePhoneItemsOfTheDesktopList() {
        XCTAssertEqual(SimpleMode.items.map(\.id),
                       ["changes", "hardware", "ph-subtitle", "model", "effort", "context", "ph-policy", "thinking", "ph-git", "terminal", "ph-monitors"])
    }
}
