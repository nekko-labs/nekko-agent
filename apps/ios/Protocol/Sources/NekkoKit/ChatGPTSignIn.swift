import Foundation
import NekkoProtocol

/// Sign in with ChatGPT on the iPhone itself (#3244, option B): the same public
/// PKCE sign-in the Codex CLI and the desktop use, so a Plus, Pro or Business
/// plan runs this iPhone's chats with no API key and no computer. The same rules
/// as Android's `ChatGptSignIn.kt`.
///
/// OpenAI's client only accepts `http://localhost:1455/auth/callback`, so while
/// the sign-in page is open the app listens on this iPhone's loopback address,
/// port 1455 (`ChatGPTCallbackListener` in the app). The page lands there with
/// the code; the listener's answer sends the browser to `nekko-agent://`, which
/// closes the sign-in sheet.
///
/// The iPhone holds its own refresh token, apart from any computer's: OpenAI
/// replaces a refresh token each time it is used, so two installs must never
/// share one. The tokens are kept as this provider's key (`Tokens.encoded`), in
/// the Keychain like every other key, and never leave the iPhone.
public enum ChatGPTSignIn {
    public static let clientId = "app_EMoamEEZ73f0CkXaXp7hrann"
    public static let authorizeURL = "https://auth.openai.com/oauth/authorize"
    public static let tokenURL = "https://auth.openai.com/oauth/token"
    public static let scopes = "openid profile email offline_access"
    public static let port: UInt16 = 1455
    public static let callbackPath = "/auth/callback"
    public static let redirectURI = "http://localhost:1455/auth/callback"
    /// Where the browser goes once the code is in hand: back to the app, closing the sheet.
    public static let returnURL = "nekko-agent://chatgpt-signed-in"
    /// Refresh this long before the access token runs out (milliseconds).
    public static let refreshMarginMs: Int64 = 5 * 60 * 1000

    public enum Problem: Error, Equatable, LocalizedError {
        case failed, portBusy, cancelled, expired
        public var errorDescription: String? {
            switch self {
            case .failed: return String(localized: "ChatGPT didn’t finish signing in. Try again.")
            case .portBusy: return String(localized: "Another app is using the port ChatGPT’s sign-in comes back to (1455). Close it and try again.")
            case .cancelled: return String(localized: "ChatGPT sign-in was cancelled.")
            case .expired: return String(localized: "Your ChatGPT sign-in has expired. Sign in again.")
            }
        }
    }

    /// What a signed-in ChatGPT provider keeps as its key. Times are milliseconds since 1970.
    public struct Tokens: Codable, Equatable, Sendable {
        public var access: String
        public var refresh: String?
        public var expiresAt: Int64
        public var accountId: String

        public init(access: String, refresh: String?, expiresAt: Int64, accountId: String) {
            self.access = access
            self.refresh = refresh
            self.expiresAt = expiresAt
            self.accountId = accountId
        }

        public var encoded: String {
            var o: [String: JSONValue] = ["access": .string(access), "expiresAt": .int(expiresAt), "accountId": .string(accountId)]
            if let refresh { o["refresh"] = .string(refresh) }
            return JSONValue.object(o).serialized()
        }

        /// The key as tokens, or nil when it isn't a ChatGPT sign-in.
        public static func decode(_ key: String?) -> Tokens? {
            guard let key, !key.isEmpty, key.utf8.count <= 64_000, let v = try? JSONValue.parse(key),
                  let access = v.str("access"), !access.isEmpty, PhoneProviders.headerValue(access),
                  let account = v.str("accountId"), !account.isEmpty, PhoneProviders.headerValue(account),
                  let expiresAt = v.long("expiresAt") else { return nil }
            return Tokens(access: access, refresh: v.str("refresh"), expiresAt: expiresAt, accountId: account)
        }

        public func needsRefresh(now: Int64) -> Bool { expiresAt - now < ChatGPTSignIn.refreshMarginMs }
    }

    /// A sign-in's `state`, checked when the browser comes back.
    public static func state() -> String { SyncCrypto.base64url(E2E.randomBytes(24)) }

    /// RFC 3986 unreserved characters only, so `+` and `/` in a value are escaped.
    static func encode(_ v: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return v.addingPercentEncoding(withAllowedCharacters: allowed) ?? v
    }

    static func form(_ pairs: [(String, String)]) -> String { pairs.map { "\($0.0)=\(encode($0.1))" }.joined(separator: "&") }

    /// The sign-in page, with the same parameters as the desktop's.
    public static func authorizeURL(challenge: String, state: String) -> URL {
        URL(string: authorizeURL + "?" + form([
            ("response_type", "code"), ("client_id", clientId), ("redirect_uri", redirectURI), ("scope", scopes),
            ("code_challenge", challenge), ("code_challenge_method", "S256"), ("state", state),
        ]))!
    }

    /// What came back to the listener.
    public enum Callback: Equatable, Sendable {
        case code(String)
        /// The person declined, or OpenAI refused (its `error`, never shown as is).
        case refused(String)
        /// Not the sign-in's answer: another path, or a stale or forged `state`.
        case ignored
    }

    /// Reads the request line the browser sent (`GET /auth/callback?code=…&state=… HTTP/1.1`).
    public static func callback(requestLine: String, expectedState: String) -> Callback {
        let parts = requestLine.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: " ")
        guard parts.count >= 2, parts[0] == "GET", requestLine.utf8.count <= 8192, !expectedState.isEmpty,
              let c = URLComponents(string: "http://localhost" + parts[1]), c.path == callbackPath else { return .ignored }
        let q = Dictionary((c.queryItems ?? []).map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { a, _ in a })
        guard q["state"] == expectedState else { return .ignored }
        if let error = q["error"], !error.isEmpty { return .refused(String(error.prefix(64))) }
        guard let code = q["code"], !code.isEmpty, code.utf8.count <= 4096, PhoneProviders.headerValue(code) else { return .ignored }
        return .code(code)
    }

    /// The HTTP answer the browser gets after the callback; its page sends the browser back to the app.
    public static func callbackResponse(ok: Bool) -> Data {
        let title = ok ? "Signed in to ChatGPT" : "ChatGPT sign-in didn’t finish"
        let body = ok ? "You can go back to Nekko Agent." : "Go back to Nekko Agent and try again."
        let html = "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\">"
            + "<title>\(title)</title></head><body style=\"font-family:-apple-system,system-ui,sans-serif;padding:32px\">"
            + "<h1 style=\"font-size:20px\">\(title)</h1><p>\(body)</p><p><a href=\"\(returnURL)\">Back to Nekko Agent</a></p>"
            + "<script>location.replace(\"\(returnURL)\")</script></body></html>"
        let bytes = Data(html.utf8)
        let head = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: \(bytes.count)\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
        return Data(head.utf8) + bytes
    }

    public static let notFound = Data("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".utf8)

    static let formHeaders = ["Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"]

    public static func tokenRequest(code: String, verifier: String) -> PhoneRequest {
        PhoneRequest(url: tokenURL, headers: formHeaders, form: form([
            ("grant_type", "authorization_code"), ("client_id", clientId), ("code", code),
            ("redirect_uri", redirectURI), ("code_verifier", verifier),
        ]))
    }

    public static func refreshRequest(_ t: Tokens) -> PhoneRequest? {
        guard let refresh = t.refresh, !refresh.isEmpty else { return nil }
        return PhoneRequest(url: tokenURL, headers: formHeaders, form: form([
            ("grant_type", "refresh_token"), ("client_id", clientId), ("refresh_token", refresh),
        ]))
    }

    /// The token endpoint's answer as tokens. The account id comes from the id token's
    /// `https://api.openai.com/auth.chatgpt_account_id` claim (else the previous sign-in's);
    /// the expiry from the access token's `exp` (else `expires_in`). Nil when it is unusable.
    public static func tokens(from data: Data, now: Int64, previous: Tokens? = nil) -> Tokens? {
        guard data.count <= 200_000, let v = try? JSONValue.parse(data),
              let access = v.str("access_token"), !access.isEmpty, PhoneProviders.headerValue(access) else { return nil }
        guard let account = v.str("id_token").flatMap(accountId) ?? accountId(access) ?? previous?.accountId else { return nil }
        let expiresIn = v.long("expires_in") ?? 3600
        let expiresAt = claims(access)?.long("exp").map { $0 * 1000 } ?? now + expiresIn * 1000
        let refresh = v.str("refresh_token").flatMap { $0.isEmpty ? nil : $0 } ?? previous?.refresh
        return Tokens(access: access, refresh: refresh, expiresAt: expiresAt, accountId: account)
    }

    /// A JWT's claims, unverified: only read for what this iPhone itself was just given.
    public static func claims(_ jwt: String) -> JSONValue? {
        let parts = jwt.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count >= 2 else { return nil }
        var b64 = parts[1].replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b64.count % 4 != 0 { b64 += "=" }
        guard let data = Data(base64Encoded: b64), let v = try? JSONValue.parse(data), v.object != nil else { return nil }
        return v
    }

    public static func accountId(_ jwt: String) -> String? {
        guard let id = claims(jwt)?["https://api.openai.com/auth"]?.str("chatgpt_account_id"),
              !id.isEmpty, id.utf8.count <= 128, PhoneProviders.headerValue(id) else { return nil }
        return id
    }
}
