import XCTest
@testable import NekkoProtocol

/// Mirrors apps/desktop/src/renderer/replyTopics.test.ts (and the Kotlin ReplyTopicsTest).
final class ReplyTopicsTests: XCTestCase {
    func testReadsTopicLines() {
        let cases: [(String, Topic, String, String)] = [
            ("**Next step**: merge it", .next, "Next step", "merge it"),
            ("**Next step:** merge it", .next, "Next step", "merge it"),
            ("**Changes**", .summary, "Changes", ""),
            ("**Not verified / blocked**: Windows", .summary, "Not verified / blocked", "Windows"),
            ("**Run this**", .command, "Run this", ""),
            ("**Decision**: kept the timeout", .decision, "Decision", "kept the timeout"),
            ("## Open questions", .question, "Open questions", ""),
            ("### **Next steps:**", .next, "Next steps", ""),
        ]
        for (line, topic, label, rest) in cases {
            XCTAssertEqual(ReplyTopics.topicLine(line), TopicLine(topic: topic, label: label, rest: rest), line)
        }
    }

    func testLeavesOtherLinesAlone() {
        for line in [
            "**Changes** to the plan come later",
            "**Important**: not a topic we name",
            "Next step: plain words are not a label",
            "## Installation",
            "- **Next step**: a list item",
        ] {
            XCTAssertNil(ReplyTopics.topicLine(line), line)
        }
    }

    func testHearsAMessageThatStopsOnAQuestion() {
        XCTAssertTrue(ReplyTopics.speaksToUser("The signup test has the same timer.\n\nShould I fix it here too?"))
        XCTAssertTrue(ReplyTopics.speaksToUser("Does this look right?**"))
        XCTAssertTrue(ReplyTopics.speaksToUser("これでいいですか？"))
    }

    func testHearsALabelAnywhere() {
        XCTAssertTrue(ReplyTopics.speaksToUser("Found it.\n\n**Decision**: kept the timeout.\n\nMoving on."))
    }

    func testLeavesAProgressNoteQuiet() {
        XCTAssertFalse(ReplyTopics.speaksToUser("I will read the test first."))
        XCTAssertFalse(ReplyTopics.speaksToUser("Why did it pass locally? The runner is slower, so I am checking that."))
    }

    func testIgnoresCode() {
        XCTAssertFalse(ReplyTopics.speaksToUser("Checking this.\n\n```md\n**Next step**: inside a fence\n```\n\nReading on."))
        XCTAssertFalse(ReplyTopics.speaksToUser("Running:\n```sh\ntest -f x?\n```"))
    }

    func testFindsAClosingQuestionWithNoLabel() {
        XCTAssertTrue(ReplyTopics.endsOnUnlabelledQuestion("All green.\n\nWant me to open the PR?"))
        XCTAssertTrue(ReplyTopics.endsOnUnlabelledQuestion("Pick one?\n\n```bash\nnpm test\n```"))
    }

    func testStaysOutWhenALabelAnnouncesTheQuestion() {
        XCTAssertFalse(ReplyTopics.endsOnUnlabelledQuestion("**Question**\n\nWant me to open the PR?"))
        XCTAssertFalse(ReplyTopics.endsOnUnlabelledQuestion("**Next step**: want me to open the PR?"))
        XCTAssertFalse(ReplyTopics.endsOnUnlabelledQuestion("**Decision**: did that break it?"))
    }

    func testStaysOutWhenTheMessageClosesOnAStatement() {
        XCTAssertFalse(ReplyTopics.endsOnUnlabelledQuestion("Did it pass? It did."))
    }

    func testCutsAMessageAtItsTopicLinesNotInsideCode() {
        let s = ReplyTopics.sections("Fixed it.\n\n**Changes**\n- one\n\n```md\n**Next step**: no\n```\n**Next step**: merge it")
        XCTAssertEqual(s.map { $0.header?.label }, [nil, "Changes", "Next step"])
        XCTAssertEqual(s[0].body, "Fixed it.")
        XCTAssertEqual(s[1].body, "- one\n\n```md\n**Next step**: no\n```")
        XCTAssertEqual(s[2].body, "merge it")
    }

    func testGivesAClosingQuestionItsHeaderOnlyWhenAsked() {
        let text = "All green.\n\nWant me to open the PR?\n\n```bash\ngh pr create\n```"
        XCTAssertEqual(ReplyTopics.sections(text).count, 1)
        let s = ReplyTopics.sections(text, askTail: true)
        XCTAssertEqual(s.map { $0.header?.topic }, [nil, .question])
        XCTAssertEqual(s[1].body, "Want me to open the PR?\n\n```bash\ngh pr create\n```")
    }

    private func say(_ id: String, _ text: String, streaming: Bool = false) -> Block {
        .assistant(id: id, text: text, reasoning: nil, streaming: streaming, interrupted: false)
    }
    private func user(_ id: String) -> Block { .user(id: id, text: "go", at: nil, images: 0) }
    private func tool(_ id: String) -> Block { .tool(id: id, name: "bash", label: "Run ls", status: .ok, output: nil, input: [:]) }

    func testVoicesFollowEachTextsPlaceInItsTurn() {
        let blocks = [
            user("u1"), say("a1", "Hello."),
            user("u2"), say("a2", "Reading the test."), tool("t1"),
            say("a3", "Should I fix signup too?"), tool("t2"), say("a4", "Fixed."),
        ]
        XCTAssertEqual(ReplyTopics.voices(blocks), [nil, nil, nil, .working, nil, .attention, nil, .reply])
    }

    func testTheNewestTextHasNoVoiceWhileItsTurnRuns() {
        let blocks = [user("u"), tool("t"), say("a", "Fixed.")]
        XCTAssertNil(ReplyTopics.voices(blocks, running: true)[2])
        XCTAssertNil(ReplyTopics.voices([user("u"), tool("t"), say("a", "Fix", streaming: true)])[2])
        XCTAssertEqual(ReplyTopics.voices(blocks)[2], .reply)
    }
}
