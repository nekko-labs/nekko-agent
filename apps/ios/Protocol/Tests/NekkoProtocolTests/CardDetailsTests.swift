import XCTest
@testable import NekkoProtocol

final class CardDetailsTests: XCTestCase {
    func testPreferencesMigrateAndRoundTrip() throws {
        let old = ChatListView.parse(Data(#"{"showEmptyGroups":true,"showPreviews":false}"#.utf8))
        XCTAssertTrue(old.showEmptyGroups)
        XCTAssertEqual(old, { var v = ChatListView.standard; v.showEmptyGroups = true; return v }(), "the retired Previews choice is ignored")
        XCTAssertTrue(old.showModel && old.showContext && old.showPullRequests && old.showUpdated && old.showSubagents)
        var hidden = ChatListView.standard
        hidden.showModel = false
        hidden.showContext = false
        hidden.showPullRequests = false
        hidden.showUpdated = false
        hidden.showSubagents = false
        XCTAssertEqual(ChatListView.parse(hidden.encoded), hidden)
        XCTAssertFalse(hidden.isStandard)
        let invalid = ChatListView.parse(Data(#"{"showContext":"false","showModel":false}"#.utf8))
        XCTAssertTrue(invalid.showContext)
        XCTAssertFalse(invalid.showModel)
        XCTAssertFalse(ChatListView.standard.showEmptyGroups)
    }

    func testSubagentsSitUnderTheirParentOldestFirst() throws {
        let list = try JSONValue.parse("""
        [{"id":"p","title":"Parent","updatedAt":9},
         {"id":"k2","title":"Second","parentSessionId":"p","createdAt":20,"modelId":"claude-haiku-5-5","providerId":"anthropic"},
         {"id":"k1","title":"First","parentSessionId":"p","createdAt":10,"modelId":"gpt-5"},
         {"id":"gone","title":"Done","parentSessionId":"p","createdAt":5,"archivedAt":30},
         {"id":"other","title":"Other","parentSessionId":"q","createdAt":1}]
        """)
        let kids = SessionSummary.subagents(list)
        XCTAssertEqual(kids["p"]?.map(\.id), ["k1", "k2"], "completed sub-agents leave; the rest are oldest first")
        XCTAssertEqual(kids["p"]?.last?.modelId, "claude-haiku-5-5")
        XCTAssertEqual(kids["q"]?.map(\.id), ["other"])
        XCTAssertEqual(SessionSummary.visible(list).map(\.id), ["p"], "sub-agents never become rows of their own")
    }

    func testContextNeverUsesAnotherModelsWindow() throws {
        let json = try JSONValue.parse(#"{"id":"a","modelId":"opus","transcriptTokens":100,"claudeCodeContext":{"modelId":"opus","used":42000,"window":200000}}"#)
        let matching = try XCTUnwrap(SessionSummary.from(json))
        XCTAssertEqual(matching.contextUsed, 42000)
        XCTAssertEqual(matching.contextWindow, 200000)
        let changed = try XCTUnwrap(SessionSummary.from(try JSONValue.parse(#"{"id":"a","modelId":"sonnet","transcriptTokens":100,"claudeCodeContext":{"modelId":"opus","used":42000,"window":200000}}"#)))
        XCTAssertNil(changed.contextWindow)
        XCTAssertNil(changed.contextUsed)
        XCTAssertEqual(changed.transcriptTokens, 100)
        XCTAssertNil(SessionSummary.from(try JSONValue.parse(#"{"id":"old"}"#))?.contextWindow)
    }
}
