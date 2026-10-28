import XCTest
import NekkoProtocol
@testable import NekkoNative

@MainActor
final class NewChatPrefsTests: XCTestCase {
    func testLastChoicesPersistPerComputerAndDoNotRedefineRecommended() throws {
        let suite = "new-chat-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let prefs = Prefs(defaults: defaults)
        let settings = PcSettings(effort: .high, defaultChatMode: .ask)
        XCTAssertEqual(prefs.newChatEffort(computer: "a", model: "gpt-5", settings: settings), .high)
        XCTAssertEqual(prefs.newChatTools(computer: "a", settings: settings), .ask)
        prefs.lastEffort["a"] = "low"
        prefs.lastTools["a"] = "yolo"
        let again = Prefs(defaults: defaults)
        XCTAssertEqual(again.newChatEffort(computer: "a", model: "gpt-5", settings: settings), .low)
        XCTAssertEqual(again.newChatTools(computer: "a", settings: settings), .yolo)
        XCTAssertEqual(again.newChatEffort(computer: "b", model: "gpt-5", settings: settings), .high)
        XCTAssertEqual(again.newChatTools(computer: "b", settings: settings), .ask)
        XCTAssertEqual(Effort.recommended(for: "gpt-5"), .normal)
        XCTAssertEqual(again.newChatTools(computer: nil, settings: PcSettings()), .guardrails)
    }

    func testUnsupportedAndCorruptSavedChoicesResolveToConcreteModelLevels() throws {
        let suite = "new-chat-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let prefs = Prefs(defaults: defaults)
        prefs.lastEffort["a"] = "max"
        XCTAssertEqual(prefs.newChatEffort(computer: "a", model: "qwen3", settings: PcSettings()), .high)
        prefs.lastEffort["a"] = "normal"
        XCTAssertEqual(prefs.newChatEffort(computer: "a", model: "claude-opus-5-5", settings: PcSettings()), .medium)
        prefs.lastEffort["a"] = "broken"
        prefs.lastTools["a"] = "broken"
        XCTAssertEqual(prefs.newChatEffort(computer: "a", model: "qwen3", settings: PcSettings(effort: .low)), .low)
        XCTAssertEqual(prefs.newChatTools(computer: "a", settings: PcSettings()), .guardrails)
    }
}
