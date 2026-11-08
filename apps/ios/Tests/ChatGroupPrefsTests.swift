import XCTest
import NekkoProtocol
@testable import NekkoNative

@MainActor
final class ChatGroupPrefsTests: XCTestCase {
    private func withDefaults(_ test: (UserDefaults) throws -> Void) throws {
        let suite = "chat-groups-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        try test(defaults)
    }

    func testNewInstallKeepsHeadedGroupsFolded() throws {
        try withDefaults { defaults in
            XCTAssertTrue(Prefs(defaults: defaults).openedChatGroups.isEmpty)
            XCTAssertNil(defaults.object(forKey: "openedChatGroups"))
        }
    }

    func testOpeningAndClosingPersistIndependentlyAcrossRecreation() throws {
        try withDefaults { defaults in
            let prefs = Prefs(defaults: defaults)
            let keys: Set<String> = ["project-a", "status:building", "date:today", "computer:a", ChatSection.completedKey]
            for key in keys { prefs.openedChatGroups.insert(key) }
            XCTAssertEqual(Set(defaults.stringArray(forKey: "openedChatGroups") ?? []), keys)
            let again = Prefs(defaults: defaults)
            XCTAssertEqual(again.openedChatGroups, keys)
            again.openedChatGroups.remove("status:building")
            XCTAssertEqual(Prefs(defaults: defaults).openedChatGroups, keys.subtracting(["status:building"]))
            again.openedChatGroups.removeAll()
            XCTAssertTrue(Prefs(defaults: defaults).openedChatGroups.isEmpty)
        }
    }

    func testViewChangesAndSearchDoNotOverwriteSavedDisclosure() throws {
        try withDefaults { defaults in
            let prefs = Prefs(defaults: defaults)
            prefs.openedChatGroups = ["status:watching"]
            prefs.chatListView.groupBy = .status
            let chats = SessionSummary.visible(try JSONValue.parse(#"[{"id":"work","title":"Build the app","phase":"building","exchangeCount":1}]"#))
            let sections = ChatSections.make(chats, folders: [], view: prefs.chatListView, activity: ["work": .running], now: 0)
            let building = try XCTUnwrap(sections.first { $0.key == "status:building" })
            XCTAssertTrue(building.isOpen(opened: prefs.openedChatGroups, searching: true))
            XCTAssertFalse(building.isOpen(opened: prefs.openedChatGroups, searching: false))
            prefs.chatListView.groupBy = .project
            prefs.chatListView = .standard
            XCTAssertEqual(Prefs(defaults: defaults).openedChatGroups, ["status:watching"])
        }
    }

    func testInvalidStorageFallsBackAndDuplicateKeysAreHarmless() throws {
        try withDefaults { defaults in
            defaults.set(42, forKey: "openedChatGroups")
            XCTAssertTrue(Prefs(defaults: defaults).openedChatGroups.isEmpty)
            defaults.set(["status:building", "status:building"], forKey: "openedChatGroups")
            XCTAssertEqual(Prefs(defaults: defaults).openedChatGroups, ["status:building"])
        }
    }
}
