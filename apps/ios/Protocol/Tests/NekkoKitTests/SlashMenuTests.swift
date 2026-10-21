import XCTest
@testable import NekkoKit

final class SlashMenuTests: XCTestCase {
    private func query(_ s: String) -> String? { SlashMenu.trigger(s)?.query }

    func testEmptyDraftOpensAsBefore() {
        XCTAssertEqual(SlashMenu.trigger("/"), .init(query: "", before: ""))
        XCTAssertEqual(SlashMenu.trigger("/pl"), .init(query: "pl", before: ""))
        XCTAssertTrue(SlashMenu.trigger("/pl")!.atStart)
        XCTAssertNil(SlashMenu.trigger("/plan the work"), "a typed-out `/name rest` closes the menu")
        XCTAssertNil(SlashMenu.trigger(""))
        XCTAssertNil(SlashMenu.trigger("Help me"))
    }

    func testOpensAfterExistingText() {
        XCTAssertEqual(SlashMenu.trigger("Help me with this /"), .init(query: "", before: "Help me with this "))
        XCTAssertEqual(SlashMenu.trigger("Help me with this /pl"), .init(query: "pl", before: "Help me with this "))
        XCTAssertEqual(SlashMenu.trigger("line\n/"), .init(query: "", before: "line\n"))
        XCTAssertEqual(SlashMenu.trigger("line\n/re"), .init(query: "re", before: "line\n"))
        XCTAssertFalse(SlashMenu.trigger("Help me /")!.atStart)
    }

    func testDoesNotOpenInsideWordsOrUrls() {
        XCTAssertNil(query("a/b"))
        XCTAssertNil(query("see a/"))
        XCTAssertNil(query("https://x.com/"))
        XCTAssertNil(query("open https://x.com/pl"))
        XCTAssertNil(query("Help me / now"))
        XCTAssertNil(query("Help me /pl "))
        XCTAssertNil(query("Help me //"))
    }

    func testPickingASkillKeepsTheTextBefore() {
        XCTAssertEqual(SlashMenu.textAfterSkill("/pl"), "")
        XCTAssertEqual(SlashMenu.textAfterSkill("/"), "")
        XCTAssertEqual(SlashMenu.textAfterSkill("Help me with this /pl"), "Help me with this ")
        XCTAssertEqual(SlashMenu.textAfterSkill("line\n/"), "line\n")
        XCTAssertEqual(SlashMenu.textAfterSkill("no menu here"), "no menu here")
    }

    func testPickingAPromptReplacesOnlyTheQuery() {
        XCTAssertEqual(SlashMenu.textAfterPrompt("/fi", promptText: "Fix the tests."), "", "at the start it becomes the chip")
        XCTAssertEqual(SlashMenu.textAfterPrompt("Help me with this /fi", promptText: "Fix the tests."),
                       "Help me with this Fix the tests.")
        XCTAssertEqual(SlashMenu.textAfterPrompt("Context\n/", promptText: "Review it."), "Context\nReview it.")
        XCTAssertEqual(SlashMenu.textAfterPrompt("a/b", promptText: "x"), "a/b")
    }
}
