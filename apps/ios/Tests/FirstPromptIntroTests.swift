import XCTest
import NekkoProtocol
@testable import NekkoNative

/// When "Send your first prompt" opens over a new chat (FirstPromptIntroView.shouldShow).
@MainActor
final class FirstPromptIntroTests: XCTestCase {
    private func chat(_ id: String, exchanges: Int?) -> SessionSummary {
        var o: [String: JSONValue] = ["id": .string(id), "title": .string(id)]
        if let exchanges { o["exchangeCount"] = .int(Int64(exchanges)) }
        return SessionSummary.from(.object(o))!
    }

    func testOpensOnlyOnAFirstEverComputerChat() {
        let show = FirstPromptIntroView.shouldShow
        XCTAssertTrue(show(false, false, true, []), "no chats yet")
        XCTAssertTrue(show(false, false, true, [chat("draft", exchanges: 0)]), "only empty chats")
        XCTAssertFalse(show(true, false, true, []), "already seen")
        XCTAssertFalse(show(false, true, true, []), "a chat on this iPhone has no photos or folders")
        XCTAssertFalse(show(false, false, false, []), "an unread list is not an empty one")
        XCTAssertFalse(show(false, false, true, [chat("a", exchanges: 0), chat("b", exchanges: 2)]), "someone who already chatted")
        XCTAssertFalse(show(false, false, true, [chat("old", exchanges: nil)]), "an unknown count counts as used")
    }

    func testEveryStepHasItsVideosInBothThemes() {
        for step in FirstPromptIntroView.steps {
            for theme in ["light", "dark"] {
                XCTAssertNotNil(Bundle.main.url(forResource: "first-prompt-\(step.id)-\(theme)", withExtension: "mp4"), "\(step.id) \(theme)")
            }
        }
    }

    func testASavedChoiceWins() throws {
        let suite = "first-prompt-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set(false, forKey: "firstPromptIntroSeen")
        XCTAssertFalse(Prefs(defaults: defaults).firstPromptIntroSeen, "an explicit NO opens it in a test run")
        defaults.set(true, forKey: "firstPromptIntroSeen")
        XCTAssertTrue(Prefs(defaults: defaults).firstPromptIntroSeen)
    }
}
