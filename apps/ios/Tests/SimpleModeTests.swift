import XCTest
import NekkoProtocol
@testable import NekkoNative

@MainActor
final class SimpleModeTests: XCTestCase {
    func testDefaultsShowTheModelEffortAndContextInSimpleAndEverythingInExpert() {
        let simple = SimpleMode.items.filter { SimpleMode.shown($0.id, expert: false, [:]) }.map(\.id)
        XCTAssertEqual(simple, ["model", "effort", "context"])
        XCTAssertTrue(SimpleMode.items.allSatisfy { SimpleMode.shown($0.id, expert: true, [:]) })
    }

    func testEachChoiceInEachMode() {
        XCTAssertTrue(SimpleMode.shown("thinking", expert: false, ["thinking": .show]))
        XCTAssertTrue(SimpleMode.shown("thinking", expert: true, ["thinking": .show]))
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
        XCTAssertFalse(SimpleMode.shown("thinking", expert: false, [:], localModelLoaded: true))
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

    func testStepsSummaryText() {
        XCTAssertEqual(StepFold.summary(steps: 4, thought: true, running: false), "Took 4 steps")
        XCTAssertEqual(StepFold.summary(steps: 1, thought: false, running: false), "Took 1 step")
        XCTAssertEqual(StepFold.summary(steps: 4, thought: false, running: false, seconds: 12), "Took 4 steps · 12s")
        XCTAssertEqual(StepFold.summary(steps: 0, thought: true, running: false), "Thought it through")
        XCTAssertEqual(StepFold.summary(steps: 2, thought: false, running: true), "Working · 2 steps so far")
        XCTAssertEqual(StepFold.summary(steps: 1, thought: false, running: true, seconds: 5), "Working · 1 step so far")
        XCTAssertEqual(StepFold.summary(steps: 0, thought: true, running: true), "Working")
    }

    func testFoldingPutsOneSummaryPerTurnAndOpensInPlace() {
        func tool(_ id: String) -> TranscriptRow { .block(.tool(id: id, name: "read", label: "Read \(id)", status: .ok, output: nil, input: [:])) }
        let rows: [TranscriptRow] = [
            .block(.user(id: "u1", text: "Fix it", at: nil, images: 0)),
            .block(.assistant(id: "a1", text: "", reasoning: "Thinking", streaming: false, interrupted: false)),
            tool("t1"), tool("t2"),
            .block(.assistant(id: "a2", text: "Done.", reasoning: nil, streaming: false, interrupted: false)),
            .block(.user(id: "u2", text: "Thanks", at: nil, images: 0)),
            .block(.assistant(id: "a3", text: "You're welcome.", reasoning: nil, streaming: false, interrupted: false)),
        ]
        let folded = TranscriptRow.folded(rows, open: [])
        XCTAssertEqual(folded.map(\.id), ["u1", "steps-u1", "a1", "a2", "u2", "a3"])
        if case .summary(_, let steps, let thought, let running) = folded[1] {
            XCTAssertEqual(steps, 2); XCTAssertTrue(thought); XCTAssertFalse(running)
        } else { XCTFail("the summary sits where the first step was") }
        if case .row(_, let reasoning) = folded[2] { XCTAssertFalse(reasoning, "folded turns keep reasoning out of sight") }
        let open = TranscriptRow.folded(rows, open: ["u1"])
        XCTAssertEqual(open.map(\.id), ["u1", "steps-u1", "a1", "t1", "t2", "a2", "u2", "a3"])
        if case .row(_, let reasoning) = open[2] { XCTAssertTrue(reasoning) }
        let live = TranscriptRow.folded(Array(rows.prefix(4)), open: [], running: true)
        if case .summary(_, _, _, let running) = live[1] { XCTAssertTrue(running) } else { XCTFail() }
    }

    func testUnknownIdsAlwaysShow() {
        XCTAssertTrue(SimpleMode.shown("not-a-control", expert: false, ["not-a-control": .hide]))
        XCTAssertEqual(SimpleMode.visibility("not-a-control", [:]), .show)
    }

    func testParseIgnoresBadJsonUnknownIdsBadValuesAndDefaults() {
        XCTAssertEqual(SimpleMode.parse("{not json"), [:])
        XCTAssertEqual(SimpleMode.parse("[\"effort\"]"), [:])
        XCTAssertEqual(SimpleMode.parse(nil), [:])
        XCTAssertEqual(SimpleMode.parse(#"{"effort":"expert","nope":"hide","context":"sometimes","model":"show","terminal":3}"#),
                       ["effort": .expert])
    }

    func testEncodeKeepsOnlyChangesAndRoundTripsThroughPrefs() throws {
        XCTAssertEqual(SimpleMode.encode(["effort": .expert, "model": .show, "nope": .hide]), #"{"effort":"expert"}"#)
        let suite = "simple-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let prefs = Prefs(defaults: defaults)
        XCTAssertFalse(prefs.expertMode, "a new install starts in Simple")
        XCTAssertFalse(prefs.shows("thinking"))
        prefs.simpleChoices["thinking"] = .show
        prefs.simpleChoices["model"] = .hide
        let again = Prefs(defaults: defaults)
        XCTAssertEqual(again.simpleChoices, ["thinking": .show, "model": .hide])
        XCTAssertTrue(again.shows("thinking"))
        XCTAssertFalse(again.shows("model"))
    }

    func testThePillCountsPairedComputersFromTwo() {
        XCTAssertNil(ComputerMenu.paired(0))
        XCTAssertNil(ComputerMenu.paired(1))
        XCTAssertEqual(ComputerMenu.paired(2), "2 paired")
        XCTAssertEqual(ComputerMenu.paired(5), "5 paired")
    }

    func testTheEffortSliderSnapsToTheNearestLevel() {
        // Four levels on a 200 pt bar: a column of 50 pt each, the stop in its middle.
        XCTAssertEqual(EffortSlider.x(0, count: 4, width: 200), 25)
        XCTAssertEqual(EffortSlider.x(3, count: 4, width: 200), 175)
        XCTAssertEqual(EffortSlider.x(nil, count: 4, width: 200), 100, "no level sits in the middle")
        XCTAssertEqual(EffortSlider.index(at: 0, count: 4, width: 200), 0)
        XCTAssertEqual(EffortSlider.index(at: 74, count: 4, width: 200), 1)
        XCTAssertEqual(EffortSlider.index(at: 199, count: 4, width: 200), 3)
        XCTAssertEqual(EffortSlider.index(at: -40, count: 4, width: 200), 0, "a drag past the ends stays on the bar")
        XCTAssertEqual(EffortSlider.index(at: 400, count: 4, width: 200), 3)
        XCTAssertEqual(EffortSlider.index(at: 10, count: 4, width: 0), 0)
    }

    func testIdsMatchThePhoneItemsOfTheDesktopList() {
        XCTAssertEqual(SimpleMode.items.map(\.id),
                       ["changes", "hardware", "ph-subtitle", "model", "effort", "context", "ph-policy", "thinking", "ph-git", "terminal", "ph-monitors"])
    }
}
