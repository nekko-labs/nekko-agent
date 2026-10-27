import XCTest
@testable import NekkoProtocol

/// The shared grammar fixture (packages/shared/fixtures/voice-commands.json), the
/// same cases the TS grammar (Vitest) runs. Cases marked desktop-only are skipped.
final class VoiceCommandsTests: XCTestCase {
    private func intent(_ v: JSONValue) throws -> VoiceIntent {
        switch v.str("kind") {
        case "dictation": return .dictation(v.str("text") ?? "")
        case "new-session": return .newSession
        case "complete-session": return .completeSession
        case "navigate": return .navigate(v.str("view") ?? "")
        case "erase": return .erase
        case "clear": return .clear
        case "send": return .send
        case "status": return .status
        case "ship": return .ship
        case "open-chat": return .openChat(query: v.str("query") ?? "", text: v.str("text") ?? "")
        case "pick": return .pick(Int(v.long("n") ?? 0))
        case "yes": return .yes
        case "no": return .no
        case "unknown": return .unknown(v.str("text") ?? "")
        default: throw XCTSkip("fixture intent this test does not map: \(String(describing: v))")
        }
    }

    func testSharedFixture() throws {
        let file = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("packages/shared/fixtures/voice-commands.json")
        let cases = try XCTUnwrap(JSONValue.parse(Data(contentsOf: file))["cases"]?.array)
        var ran = 0
        for c in cases {
            let platforms = c["platforms"]?.array?.compactMap(\.string)
            if let platforms, !platforms.contains("ios") { continue }
            let say = c.str("say") ?? ""
            let want = try intent(try XCTUnwrap(c["intent"]))
            XCTAssertEqual(parseVoiceIntent(say), want, say)
            XCTAssertEqual(splitVoiceSegments(say), [want], "split: \(say)")
            ran += 1
        }
        XCTAssertGreaterThanOrEqual(ran, 40)
    }

    func testGoParsesDesktopAndScreenTargets() {
        XCTAssertEqual(parseVoiceIntent("Nekko, switch to desktop 2."), .go("desktop:2"))
        XCTAssertEqual(parseVoiceIntent("Neko go to desktop to"), .go("desktop:2"))
        XCTAssertEqual(parseVoiceIntent("Nekko switch to the previous space"), .go("desktop:-1"))
        XCTAssertEqual(parseVoiceIntent("Nekko show screen three"), .go("screen:3"))
        XCTAssertEqual(parseVoiceIntent("Nekko switch to desktop purple"), .unknown("Nekko switch to desktop purple"))
    }

    func testSplitVoiceSegments() {
        XCTAssertEqual(splitVoiceSegments("Fix the login bug. Nekko, send it."), [.dictation("Fix the login bug."), .send])
        XCTAssertEqual(splitVoiceSegments("Tell Nekko to send it."), [.dictation("Tell Nekko to send it.")])
        XCTAssertEqual(splitVoiceSegments("Fix the bug. Then add a test! Nekko ship it"), [.dictation("Fix the bug. Then add a test!"), .ship])
        XCTAssertEqual(splitVoiceSegments("Nekko. Send it."), [.send])
        XCTAssertEqual(splitVoiceSegments("Fix it. Nekko? Erase that."), [.dictation("Fix it."), .erase])
        XCTAssertEqual(splitVoiceSegments("Nekko."), [.unknown("Nekko.")])
        XCTAssertEqual(splitVoiceSegments("  "), [])
    }
}
