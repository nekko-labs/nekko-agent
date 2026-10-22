import Foundation

/// What *Share* on a log sends (TASKS.md IO-33 FA-5): the lines on screen as
/// plain text, redacted again on the phone. The computer already redacts every
/// line it sends (`crates/nekkod/src/logs.rs` `redact`); this is the same rule
/// set, so a log from an older computer, or a secret shape the computer's copy
/// learns later, still doesn't leave the phone. Both are held to
/// `Fixtures/log-redact.json`.
public enum LogShare {
    public static let redacted = "[redacted]"

    private static func re(_ pattern: String, _ caseless: Bool = false) -> NSRegularExpression {
        try! NSRegularExpression(pattern: pattern, options: caseless ? [.caseInsensitive] : [])
    }

    private static let userinfo = re(#"([a-z][a-z0-9+.-]*://)[^/\s:@]+:[^/\s@]+@"#, true)
    private static let scheme = re(#"\b(bearer|basic|token)\s+([A-Za-z0-9._~+/=-]{8,})"#, true)
    private static let query = re(
        #"([?&](?:room|key|pair|code|token|access_token|refresh_token|id_token|sig|signature|auth|password|secret|apikey|api_key)=)[^&\s#]+"#,
        true)
    private static let pairs = re(
        #"(?<![A-Za-z0-9])((?:api[_-]?key|access[_-]?key(?:[_-]?id)?|secret[_-]?access[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|session[_-]?token|token|secret|client[_-]?secret|password|passwd|pwd|passphrase|private[_-]?key|authorization|cookie|set-cookie|session[_-]?id|x-api-key|key)["']?\s*[:=]\s*["']?)([^\s"',;&}]+)"#,
        true)
    private static let tokens = re(
        #"(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|hf_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{30,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})"#)
    private static let privateKey = re(#"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----"#, true)
    private static let hex = re(#"(?<![A-Za-z0-9])[0-9a-fA-F]{32,}(?![A-Za-z0-9])"#)
    private static let run = re(#"[A-Za-z0-9+/_-]{40,}={0,2}"#)

    /// Replace each match by what `f` makes of its capture groups (group 0 is the match).
    private static func replace(_ re: NSRegularExpression, _ text: String, _ f: ([String]) -> String) -> String {
        let ns = text as NSString
        var out = ""
        var last = 0
        for m in re.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            out += ns.substring(with: NSRange(location: last, length: m.range.location - last))
            let groups = (0..<m.numberOfRanges).map { i -> String in
                let r = m.range(at: i)
                return r.location == NSNotFound ? "" : ns.substring(with: r)
            }
            out += f(groups)
            last = m.range.location + m.range.length
        }
        return out + ns.substring(from: last)
    }

    /// A long base64-ish run that looks like a key rather than a path or a word.
    static func looksLikeKey(_ run: String) -> Bool {
        guard run.contains(where: { $0.isASCII && $0.isUppercase }), run.contains(where: { $0.isASCII && $0.isLowercase }),
              run.contains(where: { $0.isASCII && $0.isNumber }) else { return false }
        return !run.contains("/") || run.split(separator: "/", omittingEmptySubsequences: false).allSatisfy { $0.count >= 24 || $0.isEmpty }
    }

    /// One line with anything that looks like a secret replaced, exactly as the computer does.
    public static func redact(_ line: String) -> String {
        let all = NSRange(location: 0, length: (line as NSString).length)
        if privateKey.firstMatch(in: line, range: all) != nil { return "\(redacted) private key" }
        var s = replace(userinfo, line) { "\($0[1])\(redacted)@" }
        s = replace(scheme, s) { "\($0[1]) \(redacted)" }
        s = replace(query, s) { "\($0[1])\(redacted)" }
        s = replace(pairs, s) { g in
            let value = g[2]
            if value.hasPrefix(redacted) || value.caseInsensitiveCompare("bearer") == .orderedSame
                || value.caseInsensitiveCompare("basic") == .orderedSame {
                return g[1] + value
            }
            return g[1] + redacted
        }
        s = replace(tokens, s) { _ in redacted }
        s = replace(hex, s) { _ in redacted }
        return replace(run, s) { looksLikeKey($0[0]) ? redacted : $0[0] }
    }

    /// The text *Share* sends for what the log screen shows: its tail, or the
    /// lines matching a search with their numbers.
    public static func text(title: String, log: LogText, at: Date = Date()) -> String {
        var lines = ["Nekko Agent log: \(redact(title))", "Shared: \(ISO8601DateFormatter().string(from: at))",
                     "Secrets were removed on the computer and again on this iPhone. Check before you send it on.", ""]
        if let q = log.query, !q.isEmpty {
            lines.append("Lines matching \"\(redact(q))\":")
            lines += log.matches.map { "\($0.line): \(redact($0.text))" }
            if log.moreMatches { lines.append("(more lines match)") }
        } else {
            if log.truncated { lines.append("(older lines are on the computer)") }
            var body = (log.text ?? "").components(separatedBy: "\n")
            if body.last == "" { body.removeLast() }
            lines += body.map(redact)
        }
        return lines.joined(separator: "\n")
    }
}
