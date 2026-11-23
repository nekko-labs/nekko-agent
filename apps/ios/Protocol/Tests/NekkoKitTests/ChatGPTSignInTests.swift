import Foundation
import NekkoKit
import NekkoProtocol
import XCTest

/// Sign in with ChatGPT on the iPhone (#3244, option B). Android's ChatGptSignInTest holds the same rules.
final class ChatGPTSignInTests: XCTestCase {
    private func b64(_ s: String) -> String { SyncCrypto.base64url(Data(s.utf8)) }
    private func jwt(_ claims: String) -> String { "\(b64(#"{"alg":"none"}"#)).\(b64(claims)).sig" }
    private var access: String { jwt(#"{"exp":1800000000}"#) }
    private var tokens: ChatGPTSignIn.Tokens { .init(access: access, refresh: "refresh-1", expiresAt: 1_800_000_000_000, accountId: "acct-123") }

    func testAuthorizeURLMatchesTheDesktops() async {
        let url = ChatGPTSignIn.authorizeURL(challenge: "chal", state: "st")
        XCTAssertEqual(url.host, "auth.openai.com")
        let q = Dictionary(uniqueKeysWithValues: (URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(q, ["response_type": "code", "client_id": "app_EMoamEEZ73f0CkXaXp7hrann",
                           "redirect_uri": "http://localhost:1455/auth/callback", "scope": "openid profile email offline_access",
                           "code_challenge": "chal", "code_challenge_method": "S256", "state": "st"])
    }

    func testReadsOnlyItsOwnCallback() async {
        XCTAssertEqual(ChatGPTSignIn.callback(requestLine: "GET /auth/callback?code=c-1&state=st HTTP/1.1", expectedState: "st"), .code("c-1"))
        XCTAssertEqual(ChatGPTSignIn.callback(requestLine: "GET /auth/callback?error=access_denied&state=st HTTP/1.1", expectedState: "st"), .refused("access_denied"))
        for line in ["GET /auth/callback?code=c-1&state=other HTTP/1.1", "GET /auth/callback?code=c-1 HTTP/1.1",
                     "GET /favicon.ico HTTP/1.1", "POST /auth/callback?code=c-1&state=st HTTP/1.1", ""] {
            XCTAssertEqual(ChatGPTSignIn.callback(requestLine: line, expectedState: "st"), .ignored, line)
        }
        XCTAssertEqual(ChatGPTSignIn.callback(requestLine: "GET /auth/callback?code=c&state= HTTP/1.1", expectedState: ""), .ignored)
    }

    func testTheCallbackPageSendsTheBrowserBackToTheApp() async {
        let page = String(decoding: ChatGPTSignIn.callbackResponse(ok: true), as: UTF8.self)
        XCTAssertTrue(page.hasPrefix("HTTP/1.1 200 OK\r\n"))
        XCTAssertTrue(page.contains("nekko-agent://chatgpt-signed-in"))
    }

    func testTokenAndRefreshRequestsAreFormEncoded() async {
        let t = ChatGPTSignIn.tokenRequest(code: "c 1", verifier: "ver")
        XCTAssertEqual(t.url, "https://auth.openai.com/oauth/token")
        XCTAssertEqual(t.headers["Content-Type"], "application/x-www-form-urlencoded")
        XCTAssertEqual(t.form, "grant_type=authorization_code&client_id=app_EMoamEEZ73f0CkXaXp7hrann&code=c%201&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&code_verifier=ver")
        XCTAssertEqual(t.bodyData, Data(t.form!.utf8))
        XCTAssertEqual(ChatGPTSignIn.refreshRequest(tokens)?.form, "grant_type=refresh_token&client_id=app_EMoamEEZ73f0CkXaXp7hrann&refresh_token=refresh-1")
        var noRefresh = tokens
        noRefresh.refresh = nil
        XCTAssertNil(ChatGPTSignIn.refreshRequest(noRefresh))
    }

    func testReadsTheAccountAndExpiryFromTheTokens() async {
        let id = jwt(#"{"https://api.openai.com/auth":{"chatgpt_account_id":"acct-123"}}"#)
        let got = ChatGPTSignIn.tokens(from: Data(#"{"access_token":"\#(access)","refresh_token":"r","id_token":"\#(id)","expires_in":10}"#.utf8), now: 0)
        XCTAssertEqual(got, .init(access: access, refresh: "r", expiresAt: 1_800_000_000_000, accountId: "acct-123"))
        let renewed = ChatGPTSignIn.tokens(from: Data(#"{"access_token":"plain","expires_in":60}"#.utf8), now: 1000, previous: tokens)
        XCTAssertEqual(renewed, .init(access: "plain", refresh: "refresh-1", expiresAt: 61_000, accountId: "acct-123"))
        XCTAssertNil(ChatGPTSignIn.tokens(from: Data(#"{"access_token":"plain"}"#.utf8), now: 0))
        XCTAssertNil(ChatGPTSignIn.tokens(from: Data(#"{"error":"invalid_grant"}"#.utf8), now: 0))
    }

    func testTokensRoundTripAsTheKeyAndSayWhenToRefresh() async {
        XCTAssertEqual(ChatGPTSignIn.Tokens.decode(tokens.encoded), tokens)
        XCTAssertNil(ChatGPTSignIn.Tokens.decode("sk-an-api-key"))
        XCTAssertFalse(tokens.needsRefresh(now: tokens.expiresAt - 600_000))
        XCTAssertTrue(tokens.needsRefresh(now: tokens.expiresAt - 60_000))
    }

    func testAChatGPTProviderNeedsASignInAndKeepsItsAddress() async throws {
        XCTAssertThrowsError(try PhoneProviders.make(id: "p", kind: "chatgpt", label: "ChatGPT", baseUrl: nil, key: "sk-key"))
        XCTAssertThrowsError(try PhoneProviders.make(id: "p", kind: "chatgpt", label: "ChatGPT", baseUrl: "https://evil.example.com", key: tokens.encoded))
        let p = try PhoneProviders.make(id: "p", kind: "chatgpt", label: "ChatGPT", baseUrl: nil, key: tokens.encoded)
        XCTAssertEqual(p.baseUrl, "https://chatgpt.com/backend-api")
        XCTAssertEqual(p.wire, .responses)
    }

    func testChatsGoToTheResponsesAPIInTheCodexShape() async throws {
        let p = try PhoneProviders.make(id: "p", kind: "chatgpt", label: "ChatGPT", baseUrl: nil, key: tokens.encoded)
        let r = try PhoneProviders.chatRequest(p, key: tokens.encoded, model: "gpt-5.5", messages: [
            PhoneMessage(id: "1", role: .user, text: "Hi", at: 1, images: ["data:image/png;base64,AAAA"]),
            PhoneMessage(id: "2", role: .assistant, text: "Hello", at: 2),
            PhoneMessage(id: "3", role: .user, text: "More", at: 3),
        ], system: "Be brief.")
        XCTAssertEqual(r.url, "https://chatgpt.com/backend-api/codex/responses")
        XCTAssertEqual(r.headers["Authorization"], "Bearer \(access)")
        XCTAssertEqual(r.headers["chatgpt-account-id"], "acct-123")
        XCTAssertEqual(r.headers["OpenAI-Beta"], "responses=experimental")
        XCTAssertEqual(r.headers["originator"], "codex_cli_rs")
        XCTAssertEqual(r.body?.str("instructions"), "Be brief.")
        XCTAssertEqual(r.body?["store"], .bool(false))
        // The Codex backend fails the whole request on a token cap or temperature.
        for key in ["max_tokens", "max_output_tokens", "temperature", "messages"] { XCTAssertNil(r.body?[key], key) }
        XCTAssertEqual(r.body?["input"], try JSONValue.parse(#"""
            [{"type":"message","role":"user","content":[{"type":"input_text","text":"Hi"},{"type":"input_image","image_url":"data:image/png;base64,AAAA"}]},
             {"type":"message","role":"assistant","content":[{"type":"output_text","text":"Hello"}]},
             {"type":"message","role":"user","content":[{"type":"input_text","text":"More"}]}]
            """#))
    }

    func testTheModelListIsThePlansOwn() async throws {
        let p = try PhoneProviders.make(id: "p", kind: "chatgpt", label: "ChatGPT", baseUrl: nil, key: tokens.encoded)
        let r = try XCTUnwrap(try PhoneProviders.modelsRequest(p, key: tokens.encoded))
        XCTAssertEqual(r.url, "https://chatgpt.com/backend-api/codex/models?client_version=\(PhoneProviders.codexClientVersion)")
        XCTAssertEqual(r.method, "GET")
        let list = Data(#"{"models":[{"slug":"gpt-5.5-mini","display_name":"GPT-5.5 mini","priority":5},{"slug":"gpt-5.5","display_name":"GPT-5.5","priority":1},{"slug":"hidden","visibility":"hide"},{"slug":"unpicked","show_in_picker":false},{"id":"no-name"}]}"#.utf8)
        XCTAssertEqual(PhoneProviders.models(from: list, kind: "chatgpt").map(\.id), ["gpt-5.5", "gpt-5.5-mini", "no-name"])
        XCTAssertNil(try PhoneProviders.keyCheckRequest(p, key: tokens.encoded), "the model list already needs the sign-in")
    }

    func testReadsTheResponsesStream() async {
        var parser = PhoneStreamParser()
        func frame(_ json: String) -> [PhoneStreamEvent] { _ = parser.line("data: \(json)"); return parser.line("") }
        XCTAssertEqual(frame(#"{"type":"response.created","response":{"id":"r","error":null}}"#), [])
        XCTAssertEqual(frame(#"{"type":"response.output_text.delta","delta":"Hel"}"#), [.text("Hel")])
        XCTAssertEqual(frame(#"{"type":"response.reasoning_summary_text.delta","delta":"thinking"}"#), [])
        XCTAssertEqual(frame(#"{"type":"response.completed","response":{"usage":{"input_tokens":12,"output_tokens":3}}}"#), [.usage(input: 12, output: 3), .done])
        var failed = PhoneStreamParser()
        _ = failed.line(#"data: {"type":"response.failed","response":{"error":{"message":"secret detail"}}}"#)
        guard case .failed(let why)? = failed.line("").first else { return XCTFail("not a failure") }
        XCTAssertFalse(why.contains("secret"), "the provider's own text is never shown")
    }

    func testExplainsAnExpiredSignInAndThePlanLimit() async {
        XCTAssertEqual(PhoneProviders.failure(status: 401, body: Data(), kind: "chatgpt"), ChatGPTSignIn.Problem.expired.errorDescription)
        XCTAssertEqual(PhoneProviders.failure(status: 429, body: Data(), headers: ["retry-after": "120"], kind: "chatgpt"), "You’ve reached your ChatGPT plan’s limit. Try again in 2 min.")
    }
}
