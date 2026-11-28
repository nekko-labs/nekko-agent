import Foundation
import XCTest
@testable import NekkoKit

/// Settings → Beta → Models on this iPhone: off for a new install, kept for one that used it.
@MainActor
final class PhoneCloudBetaTests: XCTestCase {
    func testOffForANewInstallOnForOneThatUsedIt() {
        XCTAssertFalse(PhoneProviders.betaOn(stored: nil, hasAnything: false))
        XCTAssertTrue(PhoneProviders.betaOn(stored: nil, hasAnything: true))
    }

    func testTheUsersChoiceWins() {
        XCTAssertFalse(PhoneProviders.betaOn(stored: false, hasAnything: true))
        XCTAssertTrue(PhoneProviders.betaOn(stored: true, hasAnything: false))
    }

    func testHasAnythingCountsAProviderThatIsOff() throws {
        let s = PhoneChats(secrets: MemoryStore(), files: MemoryOfflineFiles(), http: FakePhoneHTTP())
        XCTAssertFalse(s.hasAnything)
        let p = try s.add(kind: "anthropic", label: "Claude", baseUrl: nil, key: "k")
        s.setEnabled(p.id, false)
        XCTAssertTrue(s.hasAnything)
    }

    func testOffIsNotSetUpAndSendsNothing() throws {
        let http = FakePhoneHTTP()
        let s = PhoneChats(secrets: MemoryStore(), files: MemoryOfflineFiles(), http: http, available: false)
        let p = try s.add(kind: "anthropic", label: "Claude", baseUrl: nil, key: "k")
        XCTAssertFalse(s.isSetUp)
        let id = s.create(providerId: p.id, modelId: "claude-opus-5-5", first: "Hi")
        XCTAssertTrue(http.requests.isEmpty)
        XCTAssertTrue(s.running.isEmpty)
        XCTAssertNil(s.chat(id))
        s.available = true
        XCTAssertTrue(s.isSetUp)
    }

    func testTurningItOffStopsAReplyAndKeepsTheChat() async throws {
        let http = FakePhoneHTTP()
        http.hang = true
        http.answers = [(200, [#"data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Part"}}"#])]
        let s = PhoneChats(secrets: MemoryStore(), files: MemoryOfflineFiles(), http: http)
        try s.add(kind: "anthropic", label: "Claude", baseUrl: nil, key: "k")
        let id = s.create(providerId: "claude", modelId: "claude-opus-5-5", first: "Long one")
        for _ in 0..<50 where s.chat(id)?.messages.last?.text.isEmpty != false { try await Task.sleep(nanoseconds: 2_000_000) }
        s.available = false
        await s.settled(id)
        XCTAssertTrue(s.running.isEmpty)
        XCTAssertEqual(s.chat(id)?.messages.last?.text, "Part")
        XCTAssertEqual(s.chat(id)?.messages.last?.error, "Stopped.")
        XCTAssertNotNil(s.provider("claude"))
    }
}
