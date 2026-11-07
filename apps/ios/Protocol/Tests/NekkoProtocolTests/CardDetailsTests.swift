import XCTest
@testable import NekkoProtocol

final class CardDetailsTests: XCTestCase {
    func testPreferencesMigrateAndRoundTrip() throws {
        let old = ChatListView.parse(Data(#"{"showEmptyGroups":true,"showPreviews":false}"#.utf8))
        XCTAssertTrue(old.showEmptyGroups)
        XCTAssertFalse(old.showPreviews)
        XCTAssertTrue(old.showModel && old.showContext && old.showPullRequests && old.showUpdated)
        var hidden = ChatListView.standard
        hidden.showModel = false
        hidden.showContext = false
        hidden.showPullRequests = false
        hidden.showUpdated = false
        XCTAssertEqual(ChatListView.parse(hidden.encoded), hidden)
        XCTAssertFalse(hidden.isStandard)
        let invalid = ChatListView.parse(Data(#"{"showContext":"false","showModel":false}"#.utf8))
        XCTAssertTrue(invalid.showContext)
        XCTAssertFalse(invalid.showModel)
        XCTAssertFalse(ChatListView.standard.showEmptyGroups)
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
