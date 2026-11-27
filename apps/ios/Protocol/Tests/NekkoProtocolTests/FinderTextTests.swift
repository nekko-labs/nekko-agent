import XCTest
@testable import NekkoProtocol

/// The chat list's search inside messages (#3448): the same cases as Android's FinderTextTest.
final class FinderTextTests: XCTestCase {
    private func chat(_ id: String, _ title: String, first: String? = nil, last: String? = nil) -> SessionSummary {
        var o: [String: JSONValue] = ["id": .string(id), "title": .string(title), "updatedAt": .int(1)]
        if let first { o["firstUserText"] = .string(first) }
        if let last { o["lastReplyText"] = .string(last) }
        return SessionSummary.from(.object(o))!
    }

    func testParsesAReplyLeavingOutWhatTheComputerDidNotSend() throws {
        let reply = try JSONValue.parse(#"{"s1":{"title":"t","updatedAt":5,"messages":[{"role":"user","text":"hello"},{"role":"assistant","text":"done","files":["NOTES.md"]},{"text":"no role"}]},"gone":null}"#)
        let parsed = FinderChat.parse(reply)
        XCTAssertEqual(Set(parsed.keys), ["s1", "gone"])
        XCTAssertEqual(parsed["s1"]?.messages, [FinderMessage(role: "user", text: "hello"), FinderMessage(role: "assistant", text: "done", files: ["NOTES.md"])])
        XCTAssertEqual(parsed["gone"]?.messages, [], "a chat the computer doesn't have is known to be empty")
        XCTAssertEqual(FinderChat.parse(nil), [:])
    }

    func testFindsAPhraseSaidMidChatWithItsLine() {
        let chats = [chat("a", "Release notes", first: "Group the notes", last: "Done"), chat("b", "Other", first: "x", last: "y")]
        let said = "We agreed earlier that the cache key should drop the runner image date and keep only the lockfile hash."
        let hits = FinderSearch.hits(chats, "runner image", texts: ["a": FinderChat(messages: [FinderMessage(role: "user", text: "hi"), FinderMessage(role: "assistant", text: said)])])
        XCTAssertEqual(hits.map(\.chat.id), ["a"])
        XCTAssertEqual(hits.first?.snippet, "…che key should drop the runner image date and keep only the lockfile hash.", "the same cut as the desktop finder's snippetAround")
    }

    func testKeepsTheSummarySearchWithoutTexts() {
        let chats = [chat("a", "Café résumé"), chat("b", "Bug hunt", first: "find the BUG")]
        XCTAssertEqual(FinderSearch.hits(chats, "cafe resume", texts: [:]).map(\.chat.id), ["a"])
        XCTAssertNil(FinderSearch.hits(chats, "cafe", texts: [:]).first?.snippet, "a title match needs no snippet")
        let desc = FinderSearch.hits(chats, "bug find", texts: [:])
        XCTAssertEqual(desc.map(\.chat.id), ["b"])
        XCTAssertEqual(desc.first?.snippet, "find the BUG")
        XCTAssertEqual(FinderSearch.hits(chats, "  ", texts: [:]).count, chats.count)
        XCTAssertEqual(FinderSearch.hits(chats, "lockfile", texts: [:]), [], "without texts, words only in messages find nothing")
    }

    func testNeedsEveryWordSomewhereInTheChat() {
        let chats = [chat("a", "Deploy")]
        let t = ["a": FinderChat(messages: [FinderMessage(role: "user", text: "roll back the release"), FinderMessage(role: "assistant", text: "rolled back", files: ["deploy/prod.yaml"])])]
        XCTAssertEqual(FinderSearch.hits(chats, "deploy release", texts: t).map(\.chat.id), ["a"], "one word in the title, one in a message")
        XCTAssertEqual(FinderSearch.hits(chats, "deploy staging", texts: t), [])
        XCTAssertEqual(FinderSearch.hits(chats, "prod.yaml", texts: t).first?.snippet, "deploy/prod.yaml", "a file a tool call named is searched, and shown when the text lacks the word")
    }

    func testCutsTheSnippetLikeTheDesktop() {
        XCTAssertEqual(FinderSearch.snippetAround("short line", "line"), "short line")
        XCTAssertNil(FinderSearch.snippetAround("nothing here", "missing"))
        let long = String(repeating: "a", count: 100) + " Éclair " + String(repeating: "b", count: 100)
        XCTAssertEqual(FinderSearch.snippetAround(long, "eclair"), "…" + String(repeating: "a", count: 23) + " Éclair " + String(repeating: "b", count: 59) + "…")
    }
}
