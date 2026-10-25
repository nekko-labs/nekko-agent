import Foundation

// The preview window's two reads from the computer (issue #1095):
// `artifact:read` for a file the agent linked in the chat (and the files in
// the folder of a linked HTML page, its assets), and `preview:fetch` for a
// loopback page the agent linked. The web view never reaches the network:
// its custom schemes map to these calls (`PreviewSchemes`).

/// One preview call, ready to send (both are read class). The channel names
/// are also `Channels.artifactRead` / `Channels.previewFetch` in `Wire.swift`,
/// where `WireTests` pins them to the computer's `PHONE_CHANNELS`.
public struct PreviewRequest: Equatable, Sendable {
    public static let artifactChannel = "artifact:read"
    public static let fetchChannel = "preview:fetch"

    public let channel: String
    public let args: [JSONValue]

    public static func artifact(_ sessionId: String, _ path: String) -> PreviewRequest {
        PreviewRequest(channel: artifactChannel, args: [.string(sessionId), .string(path)])
    }

    public static func fetch(_ sessionId: String, _ url: URL) -> PreviewRequest {
        PreviewRequest(channel: fetchChannel, args: [.string(sessionId), .string(url.absoluteString), ["method": "GET"]])
    }
}

/// A file as `artifact:read` returns it.
public struct ArtifactFile: Equatable, Sendable {
    public let path: String
    public let name: String
    public let mime: String
    public let size: Int64
    public let mtime: Date?
    /// The bytes sent: the text as UTF-8, or the decoded base64. Empty when truncated.
    public let data: Data
    public let isText: Bool
    /// Too large to send: no body.
    public let truncated: Bool

    public init(path: String, name: String, mime: String, size: Int64, mtime: Date?, data: Data, isText: Bool, truncated: Bool) {
        self.path = path
        self.name = name
        self.mime = mime
        self.size = size
        self.mtime = mtime
        self.data = data
        self.isText = isText
        self.truncated = truncated
    }

    public var text: String? { isText ? String(data: data, encoding: .utf8) : nil }

    public static func from(_ v: JSONValue?) -> ArtifactFile? {
        guard let v, let path = v.str("path") else { return nil }
        let isText = v.str("kind") == "text"
        var data = Data()
        if let s = v.str("content") { data = Data(s.utf8) } else if let b = v.str("base64") { data = Data(base64Encoded: b) ?? Data() }
        let name = v.str("name") ?? (path.split(separator: "/").last.map(String.init) ?? path)
        let mtime = v.dbl("mtime").flatMap { $0 > 0 ? Date(timeIntervalSince1970: $0 / 1000) : nil }
        return ArtifactFile(path: path, name: name, mime: v.str("mime").flatMap { $0.isEmpty ? nil : $0 } ?? PreviewSchemes.mime(forPath: path),
                            size: v.long("size") ?? Int64(data.count), mtime: mtime, data: data, isText: isText, truncated: v.flag("truncated"))
    }
}

/// A loopback response as `preview:fetch` returns it.
public struct PreviewResponse: Equatable, Sendable {
    public let url: String
    public let status: Int
    public let contentType: String
    public let headers: [String: String]
    public let body: Data
    public let truncated: Bool

    public init(url: String, status: Int, contentType: String, headers: [String: String] = [:], body: Data, truncated: Bool = false) {
        self.url = url
        self.status = status
        self.contentType = contentType
        self.headers = headers
        self.body = body
        self.truncated = truncated
    }

    /// A 3xx comes back as is: the computer follows redirects only on the linked origin.
    public var redirectedAway: Bool { (300..<400).contains(status) }

    public static func from(_ v: JSONValue?) -> PreviewResponse? {
        guard let v, let status = v.long("status") else { return nil }
        var headers: [String: String] = [:]
        for (k, h) in v["headers"]?.object ?? [:] { if let s = h.string { headers[k.lowercased()] = s } }
        return PreviewResponse(url: v.str("url") ?? "", status: Int(status), contentType: v.str("contentType") ?? headers["content-type"] ?? "",
                               headers: headers, body: v.str("base64").flatMap { Data(base64Encoded: $0) } ?? Data(),
                               truncated: v.flag("truncated"))
    }
}

/// The web view's custom schemes. A file: `nekko-artifact://local/<absolute
/// path>`, so a page's relative links resolve to files beside it. A loopback
/// page: `nekko-preview://<host>:<port>/<path>?<query>`, so the dev server's
/// root-relative links stay on its origin.
public enum PreviewSchemes {
    public static let artifact = "nekko-artifact"
    public static let preview = "nekko-preview"
    static let artifactHost = "local"

    /// `/Users/a/x y.html` → `nekko-artifact://local/Users/a/x%20y.html`; `C:/x/y.html` → `nekko-artifact://local/C:/x/y.html`.
    public static func url(artifact path: String) -> URL? {
        let p = path.hasPrefix("/") ? path : "/" + path
        guard let encoded = p.addingPercentEncoding(withAllowedCharacters: ChatLinks.pathAllowed) else { return nil }
        return URL(string: "\(artifact)://\(artifactHost)\(encoded)")
    }

    /// The absolute path a `nekko-artifact:` URL names (decoded, query and fragment dropped).
    public static func artifactPath(_ url: URL) -> String? {
        guard url.scheme?.lowercased() == artifact, let c = URLComponents(url: url, resolvingAgainstBaseURL: true) else { return nil }
        var path = c.percentEncodedPath.removingPercentEncoding ?? c.path
        guard path.hasPrefix("/") else { return nil }
        let chars = Array(path.prefix(4))
        if chars.count >= 4, chars[1].isLetter, chars[2] == ":", chars[3] == "/" { path.removeFirst() }
        return path
    }

    /// `http://localhost:5173/app?x=1` → `nekko-preview://localhost:5173/app?x=1`.
    public static func url(preview loopback: URL) -> URL? {
        guard var c = URLComponents(url: loopback, resolvingAgainstBaseURL: true) else { return nil }
        c.scheme = preview
        if c.percentEncodedPath.isEmpty { c.percentEncodedPath = "/" }
        return c.url
    }

    /// The loopback URL a `nekko-preview:` request stands for, with the original link's scheme.
    /// Nil for another origin than `origin` (a page reaching for a second dev server).
    public static func upstream(_ url: URL, origin: URL) -> URL? {
        guard url.scheme?.lowercased() == preview, var c = URLComponents(url: url, resolvingAgainstBaseURL: true),
              c.host?.lowercased() == origin.host?.lowercased(), c.port == origin.port else { return nil }
        c.scheme = origin.scheme?.lowercased() ?? "http"
        c.fragment = nil
        return c.url
    }

    /// Whether the web view may load `url`: only its own schemes, `about:blank` and inline data.
    public static func isAllowed(_ url: URL) -> Bool {
        switch url.scheme?.lowercased() {
        case artifact?, preview?, "about"?, "data"?, "blob"?: return true
        default: return false
        }
    }

    /// The `WKContentRuleList` JSON: block every load, then allow the app's
    /// own schemes (and inline `data:`/`blob:`). Later rules win in WebKit.
    public static let contentRules = """
    [{"trigger":{"url-filter":".*"},"action":{"type":"block"}},\
    {"trigger":{"url-filter":"^nekko-artifact:"},"action":{"type":"ignore-previous-rules"}},\
    {"trigger":{"url-filter":"^nekko-preview:"},"action":{"type":"ignore-previous-rules"}},\
    {"trigger":{"url-filter":"^data:"},"action":{"type":"ignore-previous-rules"}},\
    {"trigger":{"url-filter":"^blob:"},"action":{"type":"ignore-previous-rules"}},\
    {"trigger":{"url-filter":"^about:"},"action":{"type":"ignore-previous-rules"}}]
    """

    public static func mime(forPath path: String) -> String {
        let name = path.split(separator: "/").last.map(String.init) ?? path
        let ext = name.lastIndex(of: ".").map { name[name.index(after: $0)...].lowercased() } ?? ""
        switch ext {
        case "html", "htm": return "text/html"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "md", "markdown": return "text/markdown"
        case "txt": return "text/plain"
        case "json", "map": return "application/json"
        case "csv": return "text/csv"
        case "pdf": return "application/pdf"
        case "css": return "text/css"
        case "js", "mjs", "cjs": return "text/javascript"
        case "woff": return "font/woff"
        case "woff2": return "font/woff2"
        case "ttf": return "font/ttf"
        case "otf": return "font/otf"
        case "ico": return "image/x-icon"
        case "avif": return "image/avif"
        case "mp4": return "video/mp4"
        case "webm": return "video/webm"
        case "mp3": return "audio/mpeg"
        case "wav": return "audio/wav"
        case "wasm": return "application/wasm"
        case "xml": return "application/xml"
        default: return "application/octet-stream"
        }
    }

    /// `text/html; charset=utf-8` → (`text/html`, `utf-8`).
    public static func splitContentType(_ s: String) -> (mime: String, charset: String?) {
        let parts = s.split(separator: ";").map { $0.trimmingCharacters(in: .whitespaces) }
        let mime = (parts.first ?? "").lowercased()
        let charset = parts.dropFirst().first { $0.lowercased().hasPrefix("charset=") }
            .map { String($0.dropFirst("charset=".count)).trimmingCharacters(in: CharacterSet(charactersIn: "\"'")) }
        return (mime.isEmpty ? "application/octet-stream" : mime, charset)
    }
}

/// The preview calls' errors said plainly. The computer's start with a code
/// (`not-linked: this file was not linked in this chat`); its gate's refusals
/// read `Not allowed from a paired phone (<code>): <detail>`.
public enum PreviewError {
    public static func plain(_ message: String, loopback: Bool) -> String {
        if let r = PhoneRefusal(message) {
            switch r.code {
            case "channel-denied": return "Your computer can’t open previews for a phone yet. Update Nekko on it."
            case "value-invalid", "option-denied":
                return loopback ? "Your computer won’t open this address for a phone." : "Your computer won’t open this file for a phone."
            default: return message
            }
        }
        guard let colon = message.range(of: ": ") else { return message }
        let code = String(message[..<colon.lowerBound])
        let rest = String(message[colon.upperBound...])
        switch code {
        case "not-linked": return loopback ? "This preview wasn’t linked in this chat." : "This file wasn’t linked in this chat."
        case "unreachable": return "The preview server on your computer isn’t running."
        case "timeout": return "The preview server on your computer didn’t answer."
        case "secret-file": return "This file may hold secrets, so it never leaves your computer."
        case "not-a-file": return "That’s a folder, not a file."
        case "not-found": return rest.contains("chat") ? "This chat is no longer on your computer." : "This file is no longer on your computer."
        case "too-large": return "Too large to open on a phone."
        case "bad-request": return loopback ? "Your computer can’t open this address." : "Your computer can’t open this file."
        default: return message
        }
    }
}
