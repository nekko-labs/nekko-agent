import XCTest
import NekkoProtocol
@testable import NekkoNative

@MainActor
final class SimpleModeTests: XCTestCase {
    func testDefaultsShowTheModelAndContextInSimpleAndEverythingInExpert() {
        let simple = SimpleMode.items.filter { SimpleMode.shown($0.id, expert: false, [:]) }.map(\.id)
        XCTAssertEqual(simple, ["model", "context"])
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

    func testMonitorsShowInSimpleWhileALocalModelIsLoaded() {
        for id in ["hardware", "ph-monitors"] {
            XCTAssertFalse(SimpleMode.shown(id, expert: false, [:]), id)
            XCTAssertTrue(SimpleMode.shown(id, expert: false, [:], localModelLoaded: true), id)
            XCTAssertTrue(SimpleMode.shown(id, expert: false, [id: .show]), id)
            XCTAssertFalse(SimpleMode.shown(id, expert: false, [id: .hide], localModelLoaded: true), id)
            XCTAssertFalse(SimpleMode.shown(id, expert: true, [id: .hide], localModelLoaded: true), id)
        }
        // Only the monitors follow the local model.
        XCTAssertFalse(SimpleMode.shown("effort", expert: false, [:], localModelLoaded: true))
    }

    private func usage(_ used: Int, window: Int?) throws -> ContextUsage {
        let json = #"{"usedTokens":\#(used),"contextWindow":\#(window.map(String.init) ?? "null"),"sources":{"system":4000,"conversation":112000}}"#
        return try XCTUnwrap(ContextUsage.from(JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))))
    }

    func testLongChatSavesTheConversationFrom85Percent() throws {
        XCTAssertEqual(SimpleMode.longChatSaving(try usage(170_000, window: 200_000), used: nil), 112_000)
        let short = try usage(160_000, window: 200_000)
        XCTAssertNil(SimpleMode.longChatSaving(short, used: nil))
        XCTAssertEqual(SimpleMode.longChatSaving(short, used: 171_000), 112_000, "the reply in progress counts")
        XCTAssertNil(SimpleMode.longChatSaving(try usage(190_000, window: nil), used: nil))
        XCTAssertNil(SimpleMode.longChatSaving(nil, used: 190_000))
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
        XCTAssertFalse(prefs.shows("effort"))
        prefs.simpleChoices["effort"] = .show
        prefs.simpleChoices["model"] = .hide
        let again = Prefs(defaults: defaults)
        XCTAssertEqual(again.simpleChoices, ["effort": .show, "model": .hide])
        XCTAssertTrue(again.shows("effort"))
        XCTAssertFalse(again.shows("model"))
    }

    func testIdsMatchThePhoneItemsOfTheDesktopList() {
        XCTAssertEqual(SimpleMode.items.map(\.id),
                       ["changes", "hardware", "ph-subtitle", "model", "effort", "context", "ph-policy", "thinking", "ph-git", "terminal", "ph-monitors"])
    }
}
