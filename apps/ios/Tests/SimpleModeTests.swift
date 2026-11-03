import XCTest
import NekkoProtocol
@testable import NekkoNative

@MainActor
final class SimpleModeTests: XCTestCase {
    func testSimpleShowsOnlyTheEverydayControlsWhenNothingIsGoingOn() {
        let simple = SimpleMode.items.filter { SimpleMode.shown($0.id, expert: false, [:]) }.map(\.id)
        XCTAssertEqual(simple, ["model", "effort", "asks", "context"])
        let off = SimpleMode.items.filter { !SimpleMode.shown($0.id, expert: true, [:]) }.map(\.id)
        XCTAssertEqual(off, ["changes", "hardware", "pr-status", "ph-monitors"])
        let all = SimpleContext(localModel: true, changes: true, pr: true)
        XCTAssertTrue(SimpleMode.items.allSatisfy { SimpleMode.shown($0.id, expert: true, [:], context: all) })
    }

    func testChangesAndPrStatusNeedSomethingToShow() {
        XCTAssertFalse(SimpleMode.shown("changes", expert: true, [:]))
        XCTAssertTrue(SimpleMode.shown("changes", expert: false, [:], context: SimpleContext(changes: true)))
        XCTAssertFalse(SimpleMode.shown("changes", expert: false, ["changes": .expert], context: SimpleContext(changes: true)))
        XCTAssertFalse(SimpleMode.shown("pr-status", expert: false, [:]))
        XCTAssertTrue(SimpleMode.shown("pr-status", expert: false, [:], context: SimpleContext(pr: true)))
        XCTAssertFalse(SimpleMode.shown("ph-git", expert: false, [:], context: SimpleContext(pr: true)))
        XCTAssertEqual(SimpleMode.filesChanged(1), "1 file changed")
        XCTAssertEqual(SimpleMode.filesChanged(3), "3 files changed")
    }

    func testEachChoiceInEachMode() {
        XCTAssertTrue(SimpleMode.shown("thinking", expert: false, ["thinking": .show]))
        XCTAssertTrue(SimpleMode.shown("thinking", expert: true, ["thinking": .show]))
        XCTAssertFalse(SimpleMode.shown("model", expert: false, ["model": .expert]))
        XCTAssertTrue(SimpleMode.shown("model", expert: true, ["model": .expert]))
        XCTAssertFalse(SimpleMode.shown("context", expert: false, ["context": .hide]))
        XCTAssertFalse(SimpleMode.shown("context", expert: true, ["context": .hide]))
    }

    func testMonitorsWaitForALocalModelInBothModesUnlessPinned() {
        let running = SimpleContext(localModel: true)
        for id in ["hardware", "ph-monitors"] {
            for expert in [false, true] {
                XCTAssertFalse(SimpleMode.shown(id, expert: expert, [:]), id)
                XCTAssertTrue(SimpleMode.shown(id, expert: expert, [:], context: running), id)
                XCTAssertTrue(SimpleMode.shown(id, expert: expert, [id: .show]), id)
                XCTAssertFalse(SimpleMode.shown(id, expert: expert, [id: .hide], context: running), id)
            }
        }
        // Only the monitors follow the local model.
        XCTAssertFalse(SimpleMode.shown("thinking", expert: false, [:], context: running))
    }

    func testMonitorsOfferWhenRunningAndNotExpertOnly() throws {
        let hardware = try XCTUnwrap(SimpleMode.items.first { $0.id == "hardware" })
        XCTAssertEqual(SimpleMode.options(hardware), [.auto, .show, .hide])
        XCTAssertEqual(SimpleVisibility.show.label(for: hardware), "Always")
        XCTAssertEqual(SimpleMode.parse(#"{"hardware":"expert","terminal":"auto"}"#), [:])
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

    func testAWakeUpIsAStepOfItsTurn() {
        let rows: [TranscriptRow] = [
            .block(.user(id: "u1", text: "Watch CI", at: nil, images: 0)),
            .block(.tool(id: "t1", name: "read", label: "Read", status: .ok, output: nil, input: [:])),
            .block(.user(id: "w1", text: "[Agent watch t-9]\nWatch deadline reached at 10:00", at: nil, images: 0)),
            .block(.assistant(id: "a1", text: "CI is green.", reasoning: nil, streaming: false, interrupted: false)),
        ]
        let folded = TranscriptRow.folded(rows, open: [])
        XCTAssertEqual(folded.map(\.id), ["u1", "steps-u1", "a1"])
        if case .summary(_, let steps, _, _) = folded[1] { XCTAssertEqual(steps, 2) } else { XCTFail() }
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

    func testThePillCountsOnlineComputersFromTwo() {
        XCTAssertNil(ComputerMenu.online(0, of: 0))
        XCTAssertNil(ComputerMenu.online(1, of: 1))
        XCTAssertEqual(ComputerMenu.online(2, of: 2), "2 of 2 online")
        XCTAssertEqual(ComputerMenu.online(1, of: 5), "1 of 5 online")
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

    func testThePillSettlesAtAnEdgeAcrossOrBackUnderTheBar() {
        // A 400 pt wide screen; the pill's centre travels from y 30 to 630.
        func drop(_ x: CGFloat, _ y: CGFloat) -> PillPlacement { .drop(center: CGPoint(x: x, y: y), width: 400, minY: 30, maxY: 630) }
        XCTAssertEqual(drop(40, 330), PillPlacement(dock: .leading, y: 0.5))
        XCTAssertEqual(drop(380, 30), PillPlacement(dock: .trailing, y: 0))
        XCTAssertEqual(drop(200, 90), .standard, "within 72 pt of its place under the bar it snaps back")
        XCTAssertEqual(drop(200, 330), PillPlacement(dock: .across, y: 0.5))
        XCTAssertEqual(drop(200, 900), PillPlacement(dock: .across, y: 1), "below the space it stops at the bottom")
        XCTAssertEqual(drop(-50, -50), PillPlacement(dock: .leading, y: 0))
    }

    func testThePillPlacementRoundTripsAndIgnoresBadValues() {
        let p = PillPlacement(dock: .trailing, y: 0.25)
        XCTAssertEqual(PillPlacement.parse(p.encoded), p)
        XCTAssertEqual(PillPlacement.parse(nil), .standard)
        XCTAssertEqual(PillPlacement.parse("sideways:0.5"), .standard)
        XCTAssertEqual(PillPlacement.parse("leading:nan"), .standard)
        XCTAssertEqual(PillPlacement.parse("leading:7"), PillPlacement(dock: .leading, y: 1))
        XCTAssertTrue(PillPlacement.standard.isStandard)
        XCTAssertFalse(PillPlacement(dock: .across, y: 0.4).isStandard)
    }

    func testThePillScrollsAwayOnTheWayOnAndBackOnTheWayBack() {
        XCTAssertEqual(PillScrollHide.next(hidden: true, from: 40, to: 2, scrolling: false), false, "at the top it always shows")
        XCTAssertEqual(PillScrollHide.next(hidden: false, from: 100, to: 140, scrolling: true), true)
        XCTAssertEqual(PillScrollHide.next(hidden: true, from: 140, to: 100, scrolling: true), false)
        XCTAssertNil(PillScrollHide.next(hidden: false, from: 100, to: 140, scrolling: false), "streamed output moving the view leaves it")
        XCTAssertNil(PillScrollHide.next(hidden: false, from: 100, to: 103, scrolling: true), "a few points is not a scroll")
    }

    func testIdsMatchThePhoneItemsOfTheDesktopList() {
        XCTAssertEqual(SimpleMode.items.map(\.id),
                       ["changes", "hardware", "ph-subtitle", "model", "effort", "asks", "context", "run-settings", "thinking", "pr-status", "ph-git", "terminal", "ph-monitors"])
    }
}
