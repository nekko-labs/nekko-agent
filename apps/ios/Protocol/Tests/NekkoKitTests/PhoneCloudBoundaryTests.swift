import Foundation
import XCTest
@testable import NekkoKit
@testable import NekkoProtocol

final class PhoneCloudBoundaryTests: XCTestCase {
    func testPersistedMetadataIsRevalidatedBeforeAttachingCredentials() throws {
        for url in ["http://example.com", "https://key@example.com/v1", "https://example.com/v1?key=x", "https://example.com/#x", "https://example.com/../v1", "https://example.com/%2e%2e/v1", "https://example.com/%2fsecret", "https://example.com:0/v1"] {
            let p = PhoneProvider(id: "p", kind: "openai", label: "P", baseUrl: url)
            XCTAssertThrowsError(try PhoneProviders.chatRequest(p, key: "secret", model: "m", messages: []), url)
            XCTAssertThrowsError(try PhoneProviders.modelsRequest(p, key: "secret"), url)
        }
        var p = try PhoneProviders.make(id: "p", kind: "openai", label: "P", baseUrl: nil, key: "k")
        p.enabled = false
        XCTAssertThrowsError(try PhoneProviders.modelsRequest(p, key: "k"))
        XCTAssertThrowsError(try PhoneProviders.make(id: "p", kind: "anthropic", label: "P", baseUrl: nil, key: "k\r\nx-api-key: bad"))
        XCTAssertThrowsError(try PhoneProviders.make(id: "p", kind: "anthropic", label: "P", baseUrl: nil, key: "k", workspaceId: "ws\nleak"))
    }

    func testEveryCloudWireAndAuthShape() throws {
        for kind in PhoneProviders.kinds {
            let base = kind.defaultUrl.replacingOccurrences(of: "YOUR_RESOURCE", with: "resource").replacingOccurrences(of: "YOUR_PROJECT", with: "project")
            let p = try PhoneProviders.make(id: kind.id, kind: kind.id, label: kind.label,
                baseUrl: kind.id == "openai-compat" ? "https://example.com/v1" : base, key: "token", workspaceId: "ws")
            let r = try PhoneProviders.chatRequest(p, key: "token", model: "model", messages: [], maxTokens: 32)
            XCTAssertEqual(r.headers["Accept"], "text/event-stream")
            XCTAssertNil(r.body?["tools"])
            XCTAssertEqual(r.body?[kind.id == "openai" ? "max_completion_tokens" : "max_tokens"]?.int64, 32)
            if ["anthropic", "bedrock", "foundry"].contains(kind.id) {
                XCTAssertEqual(r.headers["x-api-key"], "token")
                XCTAssertNil(r.headers["Authorization"])
                XCTAssertEqual(r.headers["anthropic-version"], "2023-06-01")
                XCTAssertTrue(r.url.hasSuffix("/v1/messages"))
            } else {
                XCTAssertEqual(r.headers["Authorization"], "Bearer token")
                XCTAssertNil(r.headers["x-api-key"])
            }
            if kind.id == "vertex" {
                XCTAssertNil(r.body?["model"])
                XCTAssertEqual(r.body?.str("anthropic_version"), "vertex-2023-10-16")
                XCTAssertThrowsError(try PhoneProviders.chatRequest(p, key: "token", model: "../bad?key=leak", messages: []))
            }
            XCTAssertNil(kind.id == "anthropic" ? nil : r.headers["anthropic-workspace-id"])
        }
    }

    func testFramingErrorsLimitsAndTerminalState() {
        var p = PhoneStreamParser()
        XCTAssertEqual(p.line(": ping"), [])
        XCTAssertEqual(p.line(""), [])
        XCTAssertEqual(p.line("data: {\"choices\":"), [])
        XCTAssertEqual(p.line("data: [{\"delta\":{\"content\":\"Hi\"}}]}"), [])
        XCTAssertEqual(p.line(""), [.text("Hi")])
        XCTAssertEqual(p.line("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}"), [])
        XCTAssertEqual(p.line(""), [])
        XCTAssertEqual(p.line("event: error"), [])
        XCTAssertEqual(p.line("data: {\"message\":\"secret\"}"), [])
        XCTAssertEqual(p.line(""), [.failed("The provider stopped with an error. Test the provider and retry.")])
        XCTAssertEqual(p.line("data: [DONE]"), [])
        XCTAssertEqual(p.line(""), [])
        var malformed = PhoneStreamParser()
        _ = malformed.line("data: nope")
        XCTAssertEqual(malformed.line(""), [.failed("The provider sent an unreadable stream.")])
        var huge = PhoneStreamParser()
        XCTAssertEqual(huge.line(String(repeating: "x", count: PhoneStreamParser.maxFrameBytes)), [.failed("The provider's stream is too large.")])
        var done = PhoneStreamParser()
        _ = done.line("data: [DONE]")
        XCTAssertEqual(done.line(""), [.done])
        XCTAssertEqual(done.line("data: invalid"), [])
    }

    func testUntrustedErrorsNeverEchoSecrets() {
        XCTAssertFalse(PhoneProviders.failure(status: 401, body: Data("{\"error\":{\"message\":\"secret\"}}".utf8)).contains("secret"))
        let p = PhoneStreamParser()
        XCTAssertEqual(p.read("data: {\"error\":{\"message\":\"secret\"}}"), [.failed("The provider stopped with an error. Test the provider and retry.")])
    }
}

@MainActor
final class PhoneCloudLifecycleTests: XCTestCase {
    func testEOFIsFailureAndPartialTextSurvivesRestart() async throws {
        let http = FakePhoneHTTP()
        let files = MemoryOfflineFiles()
        let secrets = MemoryStore()
        let s = PhoneChats(secrets: secrets, files: files, http: http)
        let p = try s.add(kind: "openai", label: "OpenAI", baseUrl: nil, key: "k")
        http.hang = true
        http.answers = [(200, ["data: {\"choices\":[{\"delta\":{\"content\":\"Partial\"}}]}"])]
        let id = s.create(providerId: p.id, modelId: "m", first: "Hello")
        for _ in 0..<100 where s.chat(id)?.messages.last?.text.isEmpty != false { try await Task.sleep(for: .milliseconds(2)) }
        let recovered = PhoneChats(secrets: secrets, files: files, http: http)
        XCTAssertEqual(recovered.chat(id)?.messages.last?.text, "Partial")
        XCTAssertEqual(recovered.chat(id)?.messages.last?.error, "Stopped when the app closed.")
        s.stop(id)
        http.hang = false
        http.answers = [(200, ["data: {\"choices\":[{\"delta\":{\"content\":\"Cut off\"}}]}"])]
        s.retry(id)
        await s.settled(id)
        XCTAssertEqual(s.chat(id)?.messages.last?.text, "Cut off")
        XCTAssertNotNil(s.chat(id)?.messages.last?.error)
        XCTAssertTrue(s.running.isEmpty)
    }

    func testDisableRotationRemoveAndForgetInvalidateActiveAttempt() async throws {
        for action in 0..<4 {
            let http = FakePhoneHTTP()
            http.hang = true
            http.answers = [(200, ["data: {\"choices\":[{\"delta\":{\"content\":\"Old\"}}]}"])]
            let files = MemoryOfflineFiles()
            let secrets = MemoryStore()
            let s = PhoneChats(secrets: secrets, files: files, http: http)
            let p = try s.add(kind: "openai", label: "OpenAI", baseUrl: nil, key: "k")
            let id = s.create(providerId: p.id, modelId: "m", first: "Hi")
            for _ in 0..<100 where s.chat(id)?.messages.last?.text.isEmpty != false { try await Task.sleep(for: .milliseconds(2)) }
            switch action {
            case 0: s.setEnabled(p.id, false)
            case 1: s.setKey(p.id, "new")
            case 2: s.remove(p.id)
            default: s.forgetAll()
            }
            XCTAssertTrue(s.running.isEmpty)
            try await Task.sleep(for: .milliseconds(10))
            if action == 3 {
                XCTAssertTrue(files.files.isEmpty)
                XCTAssertTrue(s.chats.isEmpty)
            } else {
                XCTAssertEqual(s.chat(id)?.messages.last?.error, "Stopped.")
                XCTAssertEqual(s.chat(id)?.messages.last?.text, "Old")
            }
        }
    }
}
