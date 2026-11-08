import Foundation
import XCTest
@testable import NekkoKit
@testable import NekkoProtocol

/// A provider's answers, scripted: each request gets the next status and lines.
final class FakePhoneHTTP: PhoneHTTP, @unchecked Sendable {
    let lock = NSLock()
    var requests: [PhoneRequest] = []
    var answers: [(Int, [String])] = []
    /// Stream this line, then wait to be cancelled.
    var hang = false

    func send(_ request: PhoneRequest) async throws -> (status: Int, body: Data) {
        let (status, lines) = next(request)
        return (status, Data(lines.joined(separator: "\n").utf8))
    }

    func lines(_ request: PhoneRequest) async throws -> (status: Int, lines: AsyncThrowingStream<String, Error>) {
        let (status, lines) = next(request)
        let hang = self.hang
        let stream = AsyncThrowingStream<String, Error> { c in
            let t = Task {
                for l in lines { c.yield(l) }
                if hang {
                    while !Task.isCancelled { try? await Task.sleep(nanoseconds: 5_000_000) }
                    c.finish(throwing: CancellationError())
                } else {
                    c.finish()
                }
            }
            c.onTermination = { _ in t.cancel() }
        }
        return (status, stream)
    }

    private func next(_ r: PhoneRequest) -> (Int, [String]) {
        lock.lock(); defer { lock.unlock() }
        requests.append(r)
        return answers.isEmpty ? (500, []) : answers.removeFirst()
    }
}

@MainActor
final class PhoneChatsTests: XCTestCase {
    var secrets = MemoryStore()
    var files = MemoryOfflineFiles()
    var http = FakePhoneHTTP()

    func make() -> PhoneChats {
        var n = 0
        var t: Int64 = 1_000
        return PhoneChats(secrets: secrets, files: files, http: http, now: { t += 1; return t }, newId: { n += 1; return "m\(n)" })
    }

    func testTonePersistsAndKeepsThePhoneSystemIdentity() async throws {
        let s = make()
        XCTAssertEqual(s.tone, .standard)
        XCTAssertEqual(PhoneTone.standard.systemPrompt, PhoneProviders.system)
        s.setTone(.concise)
        XCTAssertEqual(make().tone, .concise)
        let p = try s.add(kind: "anthropic", label: "Claude", baseUrl: nil, key: "test-key")
        let id = s.create(providerId: p.id, modelId: "test-model", first: "Hello")
        await s.settled(id)
        let prompt = try XCTUnwrap(http.requests.last?.body?.str("system"))
        XCTAssertTrue(prompt.hasPrefix(PhoneProviders.system))
        XCTAssertTrue(prompt.contains(PhoneTone.concise.instructions))
        XCTAssertEqual(s.chat(id)?.messages.first?.text, "Hello")
        s.forgetAll()
        XCTAssertEqual(s.tone, .standard)
        XCTAssertEqual(make().tone, .standard)
    }

    func testToneUsesTheExistingProviderSystemFields() {
        for tone in PhoneTone.allCases {
            let p = PhoneProvider(id: "openai", kind: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1")
            let request = PhoneProviders.chatRequest(p, key: "test-key", model: "test-model", messages: [], system: tone.systemPrompt)
            XCTAssertEqual(request.body?["messages"]?.array?.first?.str("role"), "system")
            XCTAssertEqual(request.body?["messages"]?.array?.first?.str("content"), tone.systemPrompt)
        }
    }

    // MARK: Providers

    func testTheKeyGoesToTheKeychainNeverIntoTheSavedProviders() async throws {
        let s = make()
        let p = try s.add(kind: "anthropic", label: "Claude", baseUrl: nil, key: " sk-ant-secret ")
        XCTAssertEqual(p.id, "claude")
        XCTAssertEqual(p.baseUrl, "https://api.anthropic.com")
        XCTAssertEqual(secrets.get(PhoneProviders.keyName("claude")), "sk-ant-secret")
        let saved = try XCTUnwrap(files.files["this-iphone/phone-providers"]).serialized()
        XCTAssertFalse(saved.contains("sk-ant-secret"))
        XCTAssertTrue(s.isSetUp)
        // A second launch reads them back.
        XCTAssertEqual(make().providers, [p])
        s.remove("claude")
        XCTAssertNil(secrets.get(PhoneProviders.keyName("claude")))
        XCTAssertFalse(make().isSetUp)
    }

    func testAddChecksTheAddressAndTheKey() async {
        let s = make()
        XCTAssertThrowsError(try s.add(kind: "openai", label: "OpenAI", baseUrl: nil, key: "")) { XCTAssertEqual($0 as? PhoneProviders.Problem, .key) }
        XCTAssertThrowsError(try s.add(kind: "openai-compat", label: "Mine", baseUrl: "http://10.0.0.2:8080/v1", key: nil)) {
            XCTAssertEqual($0 as? PhoneProviders.Problem, .url, "the phone sends keys over https only")
        }
        XCTAssertThrowsError(try s.add(kind: "foundry", label: "Foundry", baseUrl: nil, key: "k")) {
            XCTAssertEqual($0 as? PhoneProviders.Problem, .url, "the placeholder resource must be replaced")
        }
        XCTAssertThrowsError(try s.add(kind: "claude-code", label: "Sub", baseUrl: nil, key: nil)) {
            XCTAssertEqual($0 as? PhoneProviders.Problem, .unknownKind)
        }
        XCTAssertNoThrow(try s.add(kind: "openai-compat", label: "Groq", baseUrl: "https://api.groq.com/openai/v1/", key: nil))
        XCTAssertEqual(s.providers.last?.baseUrl, "https://api.groq.com/openai/v1")
        XCTAssertTrue(s.providers.allSatisfy { !$0.baseUrl.isEmpty })
    }

    func testEveryDesktopCloudKindButTheComputerOnesIsOffered() async {
        XCTAssertEqual(PhoneProviders.kinds.map(\.id), ["anthropic", "openai", "openrouter", "bedrock", "foundry", "vertex", "openai-compat"])
        XCTAssertTrue(PhoneProviders.kind("bedrock")!.catalog.allSatisfy { $0.id.hasPrefix("anthropic.") })
        XCTAssertFalse(PhoneProviders.kind("anthropic")!.listsModels == false)
    }

    // MARK: Requests

    func testClaudeKindsSendTheMessagesApi() async throws {
        let msgs = [PhoneMessage(id: "1", role: .user, text: "Hi", at: 1), PhoneMessage(id: "2", role: .assistant, text: "", at: 2, error: "x"),
                    PhoneMessage(id: "3", role: .user, text: "Again", at: 3)]
        let claude = PhoneProvider(id: "c", kind: "anthropic", label: "C", baseUrl: "https://api.anthropic.com", workspaceId: "ws1")
        let r = PhoneProviders.chatRequest(claude, key: "k", model: "claude-opus-5-5", messages: msgs)
        XCTAssertEqual(r.url, "https://api.anthropic.com/v1/messages")
        XCTAssertEqual(r.headers["x-api-key"], "k")
        XCTAssertEqual(r.headers["anthropic-version"], "2023-06-01")
        XCTAssertEqual(r.headers["anthropic-workspace-id"], "ws1")
        XCTAssertEqual(r.body?.str("model"), "claude-opus-5-5")
        XCTAssertEqual(r.body?["stream"]?.bool, true)
        XCTAssertEqual(r.body?["messages"]?.array?.count, 2, "an empty failed reply is left out")
        XCTAssertNotNil(r.body?.str("system"))

        let bedrock = PhoneProvider(id: "b", kind: "bedrock", label: "B", baseUrl: "https://bedrock-mantle.eu-west-1.api.aws/anthropic")
        XCTAssertEqual(PhoneProviders.chatRequest(bedrock, key: "k", model: "anthropic.claude-opus-5-5", messages: msgs).url,
                       "https://bedrock-mantle.eu-west-1.api.aws/anthropic/v1/messages")

        let vertex = PhoneProvider(id: "v", kind: "vertex", label: "V", baseUrl: "https://aiplatform.googleapis.com/v1/projects/p/locations/global")
        let rv = PhoneProviders.chatRequest(vertex, key: "tok", model: "claude-sonnet-5-5", messages: msgs)
        XCTAssertEqual(rv.url, "https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/anthropic/models/claude-sonnet-5-5:streamRawPredict")
        XCTAssertEqual(rv.headers["Authorization"], "Bearer tok")
        XCTAssertNil(rv.headers["x-api-key"])
        XCTAssertNil(rv.body?["model"])
        XCTAssertEqual(rv.body?.str("anthropic_version"), "vertex-2023-10-16")
        XCTAssertNil(PhoneProviders.modelsRequest(vertex, key: "tok"), "Vertex has no models list: the catalog stands")
    }

    func testOpenAiKindsSendChatCompletions() async {
        let msgs = [PhoneMessage(id: "1", role: .user, text: "Hi", at: 1)]
        let router = PhoneProvider(id: "o", kind: "openrouter", label: "O", baseUrl: "https://openrouter.ai/api/v1")
        let r = PhoneProviders.chatRequest(router, key: "k", model: "openai/gpt-5", messages: msgs)
        XCTAssertEqual(r.url, "https://openrouter.ai/api/v1/chat/completions")
        XCTAssertEqual(r.headers["Authorization"], "Bearer k")
        XCTAssertEqual(r.headers["X-Title"], "Nekko Agent")
        XCTAssertEqual(r.body?["messages"]?.array?.map { $0.str("role") ?? "" }, ["system", "user"])
        let open = PhoneProvider(id: "x", kind: "openai-compat", label: "X", baseUrl: "https://x.example/v1")
        XCTAssertNil(PhoneProviders.chatRequest(open, key: nil, model: "m", messages: msgs).headers["Authorization"], "no key, no header")
        XCTAssertEqual(PhoneProviders.modelsRequest(open, key: nil)?.url, "https://x.example/v1/models")
    }

    func testReadsBothStreams() async {
        let p = PhoneStreamParser()
        XCTAssertEqual(p.read("event: content_block_delta"), [])
        XCTAssertEqual(p.read(#"data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}"#), [.text("Hel")])
        XCTAssertEqual(p.read(#"data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hm"}}"#), [])
        XCTAssertEqual(p.read(#"data: {"type":"message_stop"}"#), [.done])
        XCTAssertEqual(p.read(#"data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#), [.failed("Overloaded")])
        XCTAssertEqual(p.read(#"data: {"choices":[{"index":0,"delta":{"content":"lo"}}]}"#), [.text("lo")])
        XCTAssertEqual(p.read(#"data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}"#), [])
        XCTAssertEqual(p.read("data: [DONE]"), [.done])
        XCTAssertEqual(p.read(": keep-alive"), [])
    }

    func testModelsListsAndFailures() async {
        let anth = Data(#"{"data":[{"id":"claude-opus-5-5","display_name":"Claude Opus 5.5"}]}"#.utf8)
        XCTAssertEqual(PhoneProviders.models(from: anth, kind: "anthropic"), [PhoneModel(id: "claude-opus-5-5", name: "Claude Opus 5.5")])
        let openai = Data(#"{"data":[{"id":"text-embedding-3-large"},{"id":"gpt-5"},{"id":"whisper-1"},{"id":"gpt-5-mini"}]}"#.utf8)
        XCTAssertEqual(PhoneProviders.models(from: openai, kind: "openai").map(\.id), ["gpt-5-mini", "gpt-5"])
        let failed = PhoneProviders.failure(status: 401, body: Data(#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#.utf8))
        XCTAssertTrue(failed.contains("401"))
        XCTAssertTrue(failed.contains("invalid x-api-key"))
    }

    // MARK: Chats

    func testAChatStreamsItsReplyAndListsLikeAComputersChat() async throws {
        let s = make()
        try s.add(kind: "anthropic", label: "Claude", baseUrl: nil, key: "k")
        http.answers = [(200, [#"data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}"#,
                               #"data: {"type":"content_block_delta","delta":{"type":"text_delta","text":" there"}}"#,
                               #"data: {"type":"message_stop"}"#])]
        let id = s.create(providerId: "claude", modelId: "claude-opus-5-5", first: "Plan my trip to Kyoto in autumn\nwith details")
        XCTAssertTrue(PhoneProviders.isPhoneChat(id))
        XCTAssertEqual(s.activity[id], .running)
        await s.settled(id)
        XCTAssertNil(s.activity[id])
        let chat = try XCTUnwrap(s.chat(id))
        XCTAssertEqual(chat.title, "Plan my trip to Kyoto in autumn")
        XCTAssertEqual(chat.messages.map(\.text), ["Plan my trip to Kyoto in autumn\nwith details", "Hello there"])
        XCTAssertNil(chat.messages.last?.error)
        let row = try XCTUnwrap(s.summaries.first)
        XCTAssertEqual(row.id, id)
        XCTAssertEqual(row.lastReplyText, "Hello there")
        XCTAssertFalse(row.archived)
        XCTAssertEqual(http.requests.last?.headers["x-api-key"], "k")
        // Kept on the phone, and read back on the next launch.
        XCTAssertEqual(make().chat(id)?.messages.count, 2)
        XCTAssertFalse(try XCTUnwrap(files.files["this-iphone/phone-chats"]).serialized().contains("\"k\""))
    }

    func testAFailedReplySaysWhyAndRetrySendsAgain() async throws {
        let s = make()
        try s.add(kind: "openai", label: "OpenAI", baseUrl: nil, key: "bad")
        http.answers = [(401, [#"{"error":{"message":"Incorrect API key provided"}}"#])]
        let id = s.create(providerId: "openai", modelId: "gpt-5", first: "Hi")
        await s.settled(id)
        XCTAssertTrue(s.chat(id)?.messages.last?.error?.contains("Incorrect API key") == true)
        http.answers = [(200, [#"data: {"choices":[{"delta":{"content":"Hey"}}]}"#, "data: [DONE]"])]
        s.retry(id)
        await s.settled(id)
        XCTAssertEqual(s.chat(id)?.messages.map(\.text), ["Hi", "Hey"])
        XCTAssertEqual(http.requests.last?.body?["messages"]?.array?.count, 2, "system and the one prompt, not the failed reply")
    }

    func testStopKeepsWhatArrived() async throws {
        let s = make()
        try s.add(kind: "anthropic", label: "Claude", baseUrl: nil, key: "k")
        http.hang = true
        http.answers = [(200, [#"data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Part"}}"#])]
        let id = s.create(providerId: "claude", modelId: "claude-opus-5-5", first: "Long one")
        for _ in 0..<50 where s.chat(id)?.messages.last?.text.isEmpty != false { try await Task.sleep(nanoseconds: 2_000_000) }
        s.stop(id)
        await s.settled(id)
        XCTAssertEqual(s.chat(id)?.messages.last?.text, "Part")
        XCTAssertEqual(s.chat(id)?.messages.last?.error, "Stopped.")
        XCTAssertTrue(s.running.isEmpty)
    }

    func testAChatWhoseProviderWentSaysSo() async throws {
        let s = make()
        try s.add(kind: "anthropic", label: "Claude", baseUrl: nil, key: "k")
        http.answers = [(200, ["data: [DONE]"])]
        let id = s.create(providerId: "claude", modelId: "claude-opus-5-5", first: "Hi")
        await s.settled(id)
        s.remove("claude")
        s.send(id, "More")
        XCTAssertNotNil(s.chat(id)?.messages.last?.error)
        XCTAssertEqual(http.requests.count, 1)
    }

    func testListActionsAndAReplyCutOffByQuitting() async throws {
        let s = make()
        try s.add(kind: "anthropic", label: "Claude", baseUrl: nil, key: "k")
        http.hang = true
        http.answers = [(200, [])]
        let id = s.create(providerId: "claude", modelId: "claude-opus-5-5", first: "Hi")
        // The app closes mid-reply: the next launch doesn't wait for it.
        let next = make()
        XCTAssertEqual(next.chat(id)?.messages.last?.error, "Stopped when the app closed.")
        s.stop(id)
        await s.settled(id)
        s.rename(id, to: "Trip")
        s.setPinned(id, true)
        s.complete(id)
        XCTAssertEqual(s.summaries.first?.title, "Trip")
        XCTAssertTrue(s.summaries.first?.pinned == true)
        XCTAssertTrue(s.summaries.first?.archived == true)
        s.restore(id)
        XCTAssertFalse(s.summaries.first?.archived == true)
        s.delete(id)
        XCTAssertTrue(s.summaries.isEmpty)
    }

    func testForgetEverythingTakesTheKeysAndTheChats() async throws {
        let s = make()
        try s.add(kind: "anthropic", label: "Claude", baseUrl: nil, key: "k")
        http.answers = [(200, ["data: [DONE]"])]
        let id = s.create(providerId: "claude", modelId: "claude-opus-5-5", first: "Hi")
        await s.settled(id)
        s.forgetAll()
        XCTAssertTrue(secrets.values.isEmpty)
        XCTAssertTrue(s.chats.isEmpty)
        XCTAssertFalse(s.isSetUp)
        XCTAssertTrue(make().chats.isEmpty)
        XCTAssertTrue(make().providers.isEmpty)
    }
}
