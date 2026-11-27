import XCTest
@testable import NekkoKit
@testable import NekkoProtocol

/// A chat re-read after a turn, a card or a setting does not re-read the runnable
/// skills, which none of those change (#3388, audit item 10). The first read and
/// a reconnect still do.
@MainActor
final class ReloadFanOutTests: XCTestCase {
    func testSkillsAreReadOnceNotOnEveryReload() async throws {
        let (s, c) = try await ChatModelTests.makeOnline()
        let chat = ChatModel(sessionId: "s", store: s)
        await chat.start()?.value
        XCTAssertEqual(c.callsTo(Channels.skillsRunnable).count, 1, "the first read")
        XCTAssertEqual(chat.skills.map(\.name), ["review"])
        let sessionReads = c.callsTo(Channels.sessionGet).count

        for _ in 0..<3 {
            c.event(["type": "done", "sessionId": "s"])
            try await Task.sleep(nanoseconds: 400_000_000)
        }
        await chat.reload()
        XCTAssertGreaterThan(c.callsTo(Channels.sessionGet).count, sessionReads, "the chat itself is still re-read")
        XCTAssertGreaterThan(c.callsTo(MonitorChannels.contextPreview).count, 1, "and so is its context")
        XCTAssertEqual(c.callsTo(Channels.skillsRunnable).count, 1, "four re-reads, no skills read")
        XCTAssertEqual(chat.skills.map(\.name), ["review"], "the list stays")
        chat.stop()
    }

    func testAReconnectReadsSkillsAgain() async throws {
        let (s, c) = try await ChatModelTests.makeOnline()
        let chat = ChatModel(sessionId: "s", store: s)
        await chat.start()?.value
        chat.connectionChanged(.offline)
        chat.connectionChanged(.online)
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(c.callsTo(Channels.skillsRunnable).count, 2)
        chat.stop()
    }

    func testASkillsReadThatFailedIsTriedAgainByTheNextReload() async throws {
        let (s, c) = try await ChatModelTests.makeOnline()
        c.replies[Channels.skillsRunnable] = { _ in throw RelayError("busy") }
        let chat = ChatModel(sessionId: "s", store: s)
        await chat.start()?.value
        XCTAssertTrue(chat.skills.isEmpty)
        c.replies[Channels.skillsRunnable] = { _ in [["name": "review", "description": "Review"]] }
        await chat.reload()
        XCTAssertEqual(chat.skills.map(\.name), ["review"])
        await chat.reload()
        XCTAssertEqual(c.callsTo(Channels.skillsRunnable).count, 2, "two tries, then it is known")
        chat.stop()
    }
}
