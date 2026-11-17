import Foundation
import XCTest
@testable import NekkoKit
@testable import NekkoProtocol

@MainActor
final class PhoneProviderSignInTests: XCTestCase {
    func testOpenRouterSignInSwapsTheCodeForAKey() async throws {
        let url = PhoneProviders.openRouterAuthorizeURL(challenge: "abc")
        let q = URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!
        XCTAssertEqual(url.host(), "openrouter.ai")
        XCTAssertEqual(q.first { $0.name == "callback_url" }?.value, PhoneProviders.openRouterCallback)
        XCTAssertEqual(q.first { $0.name == "code_challenge_method" }?.value, "S256")

        XCTAssertEqual(PhoneProviders.openRouterCode(from: URL(string: "nekko-agent://openrouter-key?code=c1")!), "c1")
        XCTAssertNil(PhoneProviders.openRouterCode(from: URL(string: "nekko-agent://pair?code=c1")!))
        XCTAssertNil(PhoneProviders.openRouterCode(from: URL(string: "nekko-agent://openrouter-key?error=denied")!))

        let http = FakePhoneHTTP()
        http.answers = [(200, [#"{"key":"sk-or-v1-abc"}"#]), (403, [#"{"error":"bad"}"#]), (200, [#"{"key":"bad\nkey"}"#])]
        let s = PhoneChats(secrets: MemoryStore(), files: MemoryOfflineFiles(), http: http)
        let key = try await s.openRouterKey(code: "c1", verifier: "v1")
        XCTAssertEqual(key, "sk-or-v1-abc")
        let r = try XCTUnwrap(http.requests.first)
        XCTAssertEqual(r.url, "https://openrouter.ai/api/v1/auth/keys")
        XCTAssertEqual(r.body?.str("code"), "c1")
        XCTAssertEqual(r.body?.str("code_verifier"), "v1")
        do { _ = try await s.openRouterKey(code: "c", verifier: "v"); XCTFail("403 must fail") } catch {}
        do { _ = try await s.openRouterKey(code: "c", verifier: "v"); XCTFail("an unsafe key must fail") } catch {}
    }

    // Async like its neighbours: Linux test discovery can't type a list of one sync and two async tests.
    func testGeminiAndOllamaCloudAreFixedAddressOpenAIKinds() async throws {
        for id in ["gemini", "ollama-cloud"] {
            let k = try XCTUnwrap(PhoneProviders.kind(id))
            XCTAssertEqual(k.wire, .openai)
            XCTAssertFalse(k.urlRequired)
            XCTAssertNotNil(k.keyPage)
            let p = try PhoneProviders.make(id: id, kind: id, label: k.label, baseUrl: nil, key: "k")
            XCTAssertEqual(try PhoneProviders.modelsRequest(p, key: "k")?.url, "\(k.defaultUrl)/models")
        }
        // Every API-key kind with a fixed address has a key page to open.
        for k in PhoneProviders.kinds where !k.urlRequired { XCTAssertNotNil(k.keyPage, k.id) }
        let list = Data(#"{"data":[{"id":"models/gemini-2.5-flash"},{"id":"models/text-embedding-004"}]}"#.utf8)
        XCTAssertEqual(PhoneProviders.models(from: list, kind: "gemini").map(\.id), ["models/gemini-2.5-flash"])
    }
}

@MainActor
final class PhoneProviderKeyCheckTests: XCTestCase {
    /// OpenRouter and Ollama Cloud list models without a valid key, so Test asks them something a bad key is refused on.
    func testOpenModelListsStillCheckTheKey() async throws {
        for (kind, url) in [("openrouter", "https://openrouter.ai/api/v1/key"), ("ollama-cloud", "https://ollama.com/v1/chat/completions")] {
            for (status, fails) in [(401, true), (404, false), (200, false)] {
                let http = FakePhoneHTTP()
                http.answers = [(200, [#"{"data":[{"id":"m1"}]}"#]), (status, ["{}"])]
                let s = PhoneChats(secrets: MemoryStore(), files: MemoryOfflineFiles(), http: http)
                let p = try s.add(kind: kind, label: kind, baseUrl: nil, key: "k")
                let why = await s.test(p.id)
                XCTAssertEqual(why != nil, fails, "\(kind) \(status)")
                XCTAssertEqual(http.requests.last?.url, url)
                XCTAssertEqual(http.requests.last?.headers["Authorization"], "Bearer k")
            }
        }
        // Kinds whose list needs the key make no second request.
        let http = FakePhoneHTTP()
        http.answers = [(200, [#"{"data":[{"id":"m1"}]}"#])]
        let s = PhoneChats(secrets: MemoryStore(), files: MemoryOfflineFiles(), http: http)
        let p = try s.add(kind: "gemini", label: "Gemini", baseUrl: nil, key: "k")
        let why = await s.test(p.id)
        XCTAssertNil(why)
        XCTAssertEqual(http.requests.count, 1)
    }
}
