import Foundation

// Links in an assistant reply (issue #1095), with the desktop's rules
// (`apps/desktop/src/renderer/chatArtifacts.ts`): a file the agent made on the
// computer opens in the phone's preview window, read through `artifact:read`;
// a dev server on the computer's loopback opens there too, through
// `preview:fetch`; other web links open in Safari. Nothing here touches the
// network: it only decides where a tap goes.

/// Where a tapped link goes.
public enum ChatLinkTarget: Equatable, Sendable {
    /// A file on the computer: absolute, `/`-separated (`/Users/a/x.html`, `C:/x/y.html`).
    case artifact(String)
    /// A page served on the computer's loopback (`http://localhost:5173/`).
    case loopback(URL)
    /// An ordinary web or mail link, for the system to open.
    case web(URL)
    case unsupported
}

/// What a preview shows, by the file's extension (or a server's content type).
public enum ArtifactKind: String, Equatable, Sendable {
    case html, svg, image, markdown, text, pdf

    public init?(extension ext: String) {
        switch ext.lowercased() {
        case "html", "htm": self = .html
        case "svg": self = .svg
        case "png", "jpg", "jpeg", "gif", "webp": self = .image
        case "md", "markdown": self = .markdown
        case "txt", "json", "csv": self = .text
        case "pdf": self = .pdf
        default: return nil
        }
    }

    public init?(path: String) {
        let name = path.split(separator: "/").last.map(String.init) ?? path
        guard let dot = name.lastIndex(of: "."), dot != name.startIndex else { return nil }
        self.init(extension: String(name[name.index(after: dot)...]))
    }

    /// Drawn by a web view (a live thumbnail, and the preview window).
    public var isWeb: Bool { self == .html || self == .svg }
}

/// One card under a reply: a file or a loopback page the agent linked.
public struct ChatPreviewLink: Equatable, Sendable, Identifiable, Hashable {
    public enum Target: Equatable, Sendable, Hashable {
        case artifact(String)
        case loopback(URL)
    }

    public let target: Target
    /// The link's label, or a name made from the file or folder.
    public let title: String
    /// The file's name, or `host:port` for a loopback page.
    public let detail: String
    /// A file's kind; nil for a loopback page (always HTML from a server).
    public let kind: ArtifactKind?
    /// Lower-case key the cards are deduplicated on.
    public let id: String

    public init(target: Target, title: String, detail: String, kind: ArtifactKind?) {
        self.target = target
        self.title = title
        self.detail = detail
        self.kind = kind
        switch target {
        case .artifact(let p): id = "a:" + p.lowercased()
        case .loopback(let u): id = "l:" + ChatLinks.loopbackKey(u)
        }
    }

    /// The path or URL as the agent wrote it, for Copy link.
    public var original: String {
        switch target {
        case .artifact(let p): return p
        case .loopback(let u): return u.absoluteString
        }
    }

    /// A live web thumbnail: HTML files and loopback pages.
    public var isWeb: Bool { kind?.isWeb ?? true }
}

public enum ChatLinks {
    public static let previewableExtensions: Set<String> = [
        "html", "htm", "svg", "png", "jpg", "jpeg", "gif", "webp", "md", "markdown", "txt", "json", "csv", "pdf",
    ]
    static let loopbackHosts: Set<String> = ["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]

    /// Where `href` from an assistant reply goes.
    public static func classify(_ href: String) -> ChatLinkTarget {
        var s = href.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("<") && s.hasSuffix(">") { s = String(s.dropFirst().dropLast()) }
        guard !s.isEmpty else { return .unsupported }
        let lower = s.lowercased()
        if lower.hasPrefix("file:") {
            return artifactPath(fileURL: s).map(ChatLinkTarget.artifact) ?? .unsupported
        }
        if lower.hasPrefix("http://") || lower.hasPrefix("https://") {
            guard let url = URL(string: s), let host = url.host?.lowercased(), !host.isEmpty else { return .unsupported }
            if loopbackHosts.contains(host) {
                // The computer serves only a linked origin, and that needs a port.
                return url.port == nil ? .unsupported : .loopback(url)
            }
            return .web(url)
        }
        if lower.hasPrefix("mailto:") { return URL(string: s).map(ChatLinkTarget.web) ?? .unsupported }
        if isAbsolutePath(s) {
            return artifactPath(plain: s).map(ChatLinkTarget.artifact) ?? .unsupported
        }
        return .unsupported
    }

    /// The same for a URL SwiftUI hands the `openURL` action. Markdown turns a
    /// bare `/Users/a/x.html` into a relative URL, so its string is used as is.
    public static func classify(_ url: URL) -> ChatLinkTarget {
        let s = url.absoluteString.isEmpty ? url.relativeString : url.absoluteString
        return classify(s)
    }

    /// `/…`, `C:/…` or `C:\…`; not `//host/…` (protocol-relative or UNC).
    static func isAbsolutePath(_ s: String) -> Bool {
        if s.hasPrefix("/") { return !s.hasPrefix("//") }
        let c = Array(s.prefix(3))
        return c.count == 3 && c[0].isASCII && c[0].isLetter && c[1] == ":" && (c[2] == "/" || c[2] == "\\")
    }

    /// `file:///Users/a/x%20y.html` → `/Users/a/x y.html`; `file:///C:/x` → `C:/x`.
    static func artifactPath(fileURL s: String) -> String? {
        var rest = s.dropFirst("file:".count)
        if rest.hasPrefix("//") {
            rest = rest.dropFirst(2)
            // `file://localhost/x` and `file:///x`; any other host is another machine.
            guard let slash = rest.firstIndex(of: "/") else { return nil }
            let host = rest[..<slash].lowercased()
            guard host.isEmpty || host == "localhost" else { return nil }
            rest = rest[slash...]
        }
        var path = String(cutQueryAndFragment(String(rest)))
        path = path.removingPercentEncoding ?? path
        // `/C:/x` is a Windows drive.
        let c = Array(path.prefix(4))
        if c.count >= 3, c[0] == "/", c[1].isLetter, c[2] == ":" { path.removeFirst() }
        return artifactPath(plain: path, decoded: true)
    }

    /// An absolute path, normalized (`\` → `/`, `.` and `..` resolved), if it names a previewable file.
    static func artifactPath(plain s: String, decoded: Bool = false) -> String? {
        var p = cutQueryAndFragment(s)
        if !decoded, p.contains("%") { p = p.removingPercentEncoding ?? p }
        p = p.replacingOccurrences(of: "\\", with: "/")
        guard isAbsolutePath(p) else { return nil }
        var parts: [String] = []
        for part in p.split(separator: "/", omittingEmptySubsequences: true) {
            if part == ".." { if parts.count > (p.hasPrefix("/") ? 0 : 1) { parts.removeLast() } } else if part != "." { parts.append(String(part)) }
        }
        guard let name = parts.last, let dot = name.lastIndex(of: "."), dot != name.startIndex,
              previewableExtensions.contains(name[name.index(after: dot)...].lowercased()) else { return nil }
        return (p.hasPrefix("/") ? "/" : "") + parts.joined(separator: "/")
    }

    static func cutQueryAndFragment(_ s: String) -> String {
        guard let i = s.firstIndex(where: { $0 == "#" || $0 == "?" }) else { return s }
        return String(s[..<i])
    }

    static func loopbackKey(_ u: URL) -> String {
        var c = URLComponents(url: u, resolvingAgainstBaseURL: false)
        c?.fragment = nil
        return (c?.string ?? u.absoluteString).lowercased()
    }

    /// `localhost:5173`.
    public static func hostPort(_ u: URL) -> String {
        let host = u.host ?? "localhost"
        let shown = host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host
        return u.port.map { "\(shown):\($0)" } ?? shown
    }

    /// Rewrites link destinations Markdown can't read as URLs (`C:\x\y.html`,
    /// paths with spaces) into `file:` URLs, so they render as tappable links
    /// and `classify` reads them back to the same path. Code is left alone.
    public static func linkable(_ s: String) -> String {
        guard s.contains("](") else { return s }
        var out = ""
        var i = s.startIndex
        var inCode = false
        while i < s.endIndex {
            let c = s[i]
            if c == "`" { inCode.toggle(); out.append(c); i = s.index(after: i); continue }
            if !inCode, c == "]", s[i...].hasPrefix("]("), let close = s[i...].firstIndex(of: ")") {
                let destStart = s.index(i, offsetBy: 2)
                let dest = String(s[destStart..<close])
                if case .artifact(let path) = classify(dest), dest.contains("\\") || dest.contains(" ") || dest.hasPrefix("<") {
                    out += "](" + fileURL(path) + ")"
                    i = s.index(after: close)
                    continue
                }
            }
            out.append(c)
            i = s.index(after: i)
        }
        return out
    }

    /// `C:/a b/x.html` → `file:///C:/a%20b/x.html`.
    public static func fileURL(_ path: String) -> String {
        let p = path.hasPrefix("/") ? path : "/" + path
        return "file://" + (p.addingPercentEncoding(withAllowedCharacters: pathAllowed) ?? p)
    }

    static let pathAllowed: CharacterSet = {
        var set = CharacterSet.urlPathAllowed
        set.remove(charactersIn: "?#%;")
        return set
    }()

    /// The files and loopback pages a reply links, once each, in order: the
    /// cards under it. Code fences and inline code are skipped, as on the desktop.
    public static func previews(in text: String) -> [ChatPreviewLink] {
        let source = stripCode(text)
        var out: [ChatPreviewLink] = []
        var seen = Set<String>()
        func add(_ link: ChatPreviewLink?) {
            guard let link, seen.insert(link.id).inserted else { return }
            out.append(link)
        }
        // `[label](href)`, `![alt](href)`, `<http://localhost:3000>` and bare loopback URLs, in reading order.
        let pattern = #"!?\[([^\]\n]*)\]\(([^)\n]+)\)|<(https?://[^>\s]+)>|(https?://(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d+[^\s)<>\]"'`]*)"#
        guard let re = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return [] }
        let ns = source as NSString
        for m in re.matches(in: source, range: NSRange(location: 0, length: ns.length)) {
            func group(_ n: Int) -> String? {
                let r = m.range(at: n)
                return r.location == NSNotFound ? nil : ns.substring(with: r)
            }
            if let href = group(2) {
                add(link(label: group(1) ?? "", href: destination(href)))
            } else if let href = group(3) ?? group(4) {
                add(link(label: "", href: href.trimmingCharacters(in: CharacterSet(charactersIn: ".,;:!?"))))
            }
        }
        return out
    }

    /// The card a tapped link stands for: the reply's own card when it has one
    /// (it knows the link's label), else one made from the URL alone.
    public static func preview(for url: URL, in cards: [ChatPreviewLink] = []) -> ChatPreviewLink? {
        let href = url.absoluteString.isEmpty ? url.relativeString : url.absoluteString
        guard let made = link(label: "", href: href) else { return nil }
        return cards.first { $0.id == made.id } ?? made
    }

    /// A Markdown link destination without its optional title (`x.html "Title"`).
    static func destination(_ raw: String) -> String {
        let t = raw.trimmingCharacters(in: .whitespaces)
        if t.hasPrefix("<"), let end = t.firstIndex(of: ">") { return String(t[t.index(after: t.startIndex)..<end]) }
        if let space = t.firstIndex(of: " "), t[space...].contains("\"") || t[space...].contains("'") {
            return String(t[..<space])
        }
        return t
    }

    static func link(label: String, href: String) -> ChatPreviewLink? {
        let label = label.trimmingCharacters(in: .whitespaces)
        switch classify(href) {
        case .artifact(let path):
            let parts = path.split(separator: "/").map(String.init)
            let filename = parts.last ?? path
            let generic = label.isEmpty || label == filename || label == href || label == path
                || label.range(of: #"^(readme|index)(\.[a-z]+)?$"#, options: [.regularExpression, .caseInsensitive]) != nil
            var title = label
            if generic {
                let isIndex = filename.range(of: #"^(readme|index)\."#, options: [.regularExpression, .caseInsensitive]) != nil
                let base = isIndex ? (parts.count >= 2 ? parts[parts.count - 2] : "Document") : stem(filename)
                title = humanize(base)
            }
            return ChatPreviewLink(target: .artifact(path), title: title.isEmpty ? filename : title, detail: filename,
                                   kind: ArtifactKind(path: path))
        case .loopback(let url):
            let hp = hostPort(url)
            let generic = label.isEmpty || label == href || label == url.absoluteString
            return ChatPreviewLink(target: .loopback(url), title: generic ? "Preview on \(hp)" : label, detail: hp, kind: nil)
        case .web, .unsupported:
            return nil
        }
    }

    static func stem(_ filename: String) -> String {
        guard let dot = filename.lastIndex(of: "."), dot != filename.startIndex else { return filename }
        return String(filename[..<dot])
    }

    /// `design-examples_v2` → `Design examples v2`.
    static func humanize(_ s: String) -> String {
        let spaced = s.replacingOccurrences(of: "-", with: " ").replacingOccurrences(of: "_", with: " ")
        return spaced.prefix(1).uppercased() + spaced.dropFirst()
    }

    /// The text without fenced code blocks (closed or not) and inline code spans.
    static func stripCode(_ text: String) -> String {
        var out: [String] = []
        var inFence = false
        for line in text.components(separatedBy: "\n") {
            if line.trimmingCharacters(in: .whitespaces).hasPrefix("```") { inFence.toggle(); continue }
            if inFence { continue }
            out.append(line)
        }
        // Only closed spans, like the desktop's /`[^`\n]*`/.
        return out.joined(separator: "\n").replacingOccurrences(of: "`[^`\n]*`", with: "", options: .regularExpression)
    }
}
