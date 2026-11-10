import XCTest
@testable import NekkoProtocol

final class ConversationContextTests: XCTestCase {
    func testMergedPromptRemainsSeparate() throws {
        let summary = "Summary of the earlier conversation, compacted to save context:\n\n## Task and workspace\nDetails\n\n---\n\nOlder details"
        let parts = try XCTUnwrap(ConversationContext.parts(summary + "\n\n---\n\nPlease fix the keyboard"))
        XCTAssertEqual(parts.summary, summary)
        XCTAssertEqual(parts.prompt, "Please fix the keyboard")
        XCTAssertNil(ConversationContext.parts("Summary of the earlier conversation, compacted to save context:\nOnly context")?.prompt)
    }

    func testOnlyTheContinuationEnvelopeFolds() {
        XCTAssertTrue(ConversationContext.isSummary("Summary of the earlier conversation, compacted to save context:\n\n## Task and workspace\nDetails"))
        XCTAssertTrue(ConversationContext.isSummary(" \nSummary of the earlier conversation, compacted to save context:\nDetails"))
        XCTAssertFalse(ConversationContext.isSummary("## Task and workspace\nMy actual request"))
        XCTAssertFalse(ConversationContext.isSummary("Please explain this: Summary of the earlier conversation, compacted to save context:"))
        XCTAssertFalse(ConversationContext.isSummary(""))
    }
}
