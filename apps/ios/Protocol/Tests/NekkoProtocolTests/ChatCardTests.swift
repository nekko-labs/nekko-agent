import XCTest
@testable import NekkoProtocol

/// A chat row's model, context and PR chip, held to the desktop's agent card
/// (`WorkspaceCard.tsx`, `SessionPrChip.tsx`). Android: `ChatCardTest.kt`.
final class ChatCardTests: XCTestCase {
    private func chat(_ json: String) throws -> SessionSummary {
        try XCTUnwrap(SessionSummary.from(JSONValue.parse(json)))
    }

    private func prs(_ json: String) throws -> [PullRequest] {
        PullRequest.list(try JSONValue.parse(json))
    }

    func testNamesClaudeModelsAsTheDesktopCardDoes() {
        XCTAssertEqual(ChatCard.modelName("claude-opus-5-5"), "Opus 5.5")
        XCTAssertEqual(ChatCard.modelName("claude-sonnet-4-5-20250929"), "Sonnet 4.5")
        XCTAssertEqual(ChatCard.modelName("anthropic/claude-haiku-5"), "Haiku 5")
        XCTAssertEqual(ChatCard.modelName("us.anthropic.claude-opus-4-7"), "Opus 4.7")
        XCTAssertEqual(ChatCard.modelName("claude-fable-5-1"), "Fable 5.1")
        XCTAssertEqual(ChatCard.modelName("qwen/qwen3-coder:latest"), "qwen3-coder")
        XCTAssertEqual(ChatCard.modelName("gpt-5"), "gpt-5")
    }

    func testPicksTheProviderMarkFromTheKindThenTheModel() {
        XCTAssertEqual(ChatCard.providerMark(kind: "claude-code", modelId: "opus"), "anthropic")
        XCTAssertEqual(ChatCard.providerMark(kind: "bedrock", modelId: "anthropic.claude-opus-4-7"), "anthropic")
        XCTAssertEqual(ChatCard.providerMark(kind: "chatgpt", modelId: "gpt-5"), "openai")
        XCTAssertEqual(ChatCard.providerMark(kind: "gemini", modelId: nil), "google")
        XCTAssertEqual(ChatCard.providerMark(kind: "ollama-cloud", modelId: nil), "ollama")
        XCTAssertEqual(ChatCard.providerMark(kind: "openrouter", modelId: "anthropic/claude-opus-5-5"), "openrouter")
        XCTAssertNil(ChatCard.providerMark(kind: "openai-compat", modelId: "claude-opus-5-5"), "a custom endpoint has no mark")
        XCTAssertNil(ChatCard.providerMark(kind: "llamacpp", modelId: "qwen3"))
        // No kind: only an id that can be one vendor's names it.
        XCTAssertEqual(ChatCard.providerMark(kind: nil, modelId: "claude-sonnet-5-5"), "anthropic")
        XCTAssertEqual(ChatCard.providerMark(kind: nil, modelId: "gpt-5.6-sol"), "openai")
        XCTAssertEqual(ChatCard.providerMark(kind: nil, modelId: "o3"), "openai")
        XCTAssertEqual(ChatCard.providerMark(kind: "", modelId: "gemini-3-pro"), "google")
        XCTAssertNil(ChatCard.providerMark(kind: nil, modelId: "anthropic/claude-opus-5-5"), "a gateway id says nothing of the provider")
        XCTAssertNil(ChatCard.providerMark(kind: nil, modelId: "qwen3-coder"))
        XCTAssertNil(ChatCard.providerMark(kind: nil, modelId: nil))
    }

    func testGuessesTheWindowAndToneAsTheDesktop() {
        XCTAssertEqual(ChatCard.guessContextWindow("claude-opus-5-5"), 1_000_000)
        XCTAssertEqual(ChatCard.guessContextWindow("claude-sonnet-4-5"), 200_000)
        XCTAssertEqual(ChatCard.guessContextWindow("claude-haiku-4-5"), 200_000)
        XCTAssertEqual(ChatCard.guessContextWindow("opus"), 1_000_000)
        XCTAssertEqual(ChatCard.guessContextWindow("gpt-5"), 400_000)
        XCTAssertEqual(ChatCard.guessContextWindow("gpt-5.6-terra"), 272_000)
        XCTAssertEqual(ChatCard.guessContextWindow("o3"), 200_000)
        XCTAssertEqual(ChatCard.guessContextWindow("qwen3"), 128_000)
        XCTAssertEqual(ChatCard.fill(used: 59, window: 100), .room)
        XCTAssertEqual(ChatCard.fill(used: 60, window: 100), .filling)
        XCTAssertEqual(ChatCard.fill(used: 85, window: 100), .full)
        XCTAssertEqual(ChatCard.compactTokens(950), "950")
        XCTAssertEqual(ChatCard.compactTokens(4_500), "4.5k")
        XCTAssertEqual(ChatCard.compactTokens(312_400), "312k")
        XCTAssertEqual(ChatCard.compactTokens(1_000_000), "1M")
        XCTAssertEqual(ChatCard.compactTokens(1_047_576), "1M")
    }

    func testShowsContextOnlyWhileTheChatIsInProgress() throws {
        let used = try chat(#"{"id":"s","title":"t","updatedAt":1,"modelId":"claude-opus-5-5","transcriptTokens":45000}"#)
        XCTAssertEqual(ChatCard.context(used)?.text, "45k/1M")
        XCTAssertEqual(ChatCard.context(used)?.fill, .room)
        XCTAssertTrue(ChatCard.showsContext(used, activity: .running))
        XCTAssertTrue(ChatCard.showsContext(used, activity: .needsYou))
        XCTAssertFalse(ChatCard.showsContext(used, activity: nil), "a finished reply has no context pressure")
        let watching = try chat(#"{"id":"s","title":"t","updatedAt":1,"activeWatchCount":1}"#)
        XCTAssertTrue(ChatCard.showsContext(watching, activity: nil))
        let completed = try chat(#"{"id":"s","title":"t","updatedAt":1,"archivedAt":5,"activeRun":{"id":"r"}}"#)
        XCTAssertFalse(ChatCard.showsContext(completed, activity: .running))
        let reported = try chat(#"{"id":"s","title":"t","updatedAt":1,"modelId":"opus","claudeCodeContext":{"modelId":"opus","used":180000,"window":200000}}"#)
        XCTAssertEqual(ChatCard.context(reported)?.text, "180k/200k")
        XCTAssertEqual(ChatCard.context(reported)?.fill, .full)
        XCTAssertNil(ChatCard.context(try chat(#"{"id":"s","title":"t","updatedAt":1}"#)))
    }

    func testThePrChipLeadsWithThePrStillInFlight() throws {
        let list = try prs("""
        [{"url":"https://github.com/o/r/pull/3","number":3,"state":"merged"},
         {"url":"https://github.com/o/r/pull/5","number":5,"state":"open","isDraft":true},
         {"url":"https://github.com/o/r/pull/4","number":4,"state":"closed"}]
        """)
        XCTAssertEqual(ChatCard.primaryPr(list)?.number, 5)
        XCTAssertEqual(ChatCard.prStatus(ChatCard.primaryPr(list)!), .draft)
        let open = try prs("""
        [{"url":"https://github.com/o/r/pull/7","number":7,"state":"open"},
         {"url":"https://github.com/o/r/pull/9","number":9,"state":"open"},
         {"url":"https://github.com/o/other/pull/12","number":12,"state":"open"}]
        """)
        XCTAssertEqual(ChatCard.primaryPr(open)?.number, 9, "the newest in the same repository; another repo's number says nothing")
        XCTAssertNil(ChatCard.primaryPr([]))
    }
}
