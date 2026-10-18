import Foundation

/// Pairing links. Settings → Remote access on the computer shows a QR carrying
/// `nekko-agent-pair:?relay=&room=&key=&pair=` (or, from the Local Web UI,
/// `https://host/?relay=…`). Either form, or a bare query string, parses to the
/// same credentials. Mirrors `apps/mobile/src/lib/pairing.ts` and Android's `Pairing.kt`.
public struct PairingLink: Equatable, Sendable, CustomStringConvertible {
    public let relayUrl: String
    public let room: String
    /// Pairing secret. Never logged.
    public let key: String
    /// One-time enrollment code; absent when re-using an existing pairing.
    public let pair: String?

    public init(relayUrl: String, room: String, key: String, pair: String? = nil) {
        self.relayUrl = relayUrl
        self.room = room
        self.key = key
        self.pair = pair
    }

    /// Never print the secret.
    public var description: String { "PairingLink(relay=\(relayUrl), room=\(room), pair=\(pair != nil))" }
}

public enum Pairing {
    public static func parse(_ input: String) -> PairingLink? {
        let raw = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if raw.isEmpty { return nil }
        var query = raw
        if let q = raw.firstIndex(of: "?") { query = String(raw[raw.index(after: q)...]) }
        if let h = query.firstIndex(of: "#") { query = String(query[..<h]) }
        guard let params = parseQuery(query) else { return nil }
        let relay = (params["relay"] ?? "").trimmingCharacters(in: .whitespaces)
        let room = (params["room"] ?? "").trimmingCharacters(in: .whitespaces)
        let key = (params["key"] ?? "").trimmingCharacters(in: .whitespaces)
        guard !relay.isEmpty, !room.isEmpty, !key.isEmpty else { return nil }
        let lower = relay.lowercased()
        guard lower.hasPrefix("ws://") || lower.hasPrefix("wss://") else { return nil }
        guard isHex(room, 8...128), isHex(key, 16...256) else { return nil }
        var pair = params["pair"]?.trimmingCharacters(in: .whitespaces).uppercased()
        if pair?.isEmpty == true { pair = nil }
        var url = relay
        while url.hasSuffix("/") { url.removeLast() }
        return PairingLink(relayUrl: url, room: room, key: key, pair: pair)
    }

    /// Relay host for display ("relay.nekkoagent.com", "studio.tail1234.ts.net:4400").
    public static func relayHost(_ relayUrl: String) -> String {
        var s = relayUrl
        if let r = s.range(of: "://") { s = String(s[r.upperBound...]) }
        return String(s.prefix { $0 != "/" })
    }

    private static func isHex(_ s: String, _ len: ClosedRange<Int>) -> Bool {
        len.contains(s.count) && s.allSatisfy { $0.isHexDigit && $0.isASCII }
    }

    /// URLSearchParams semantics: first value wins, `+` is a space.
    private static func parseQuery(_ q: String) -> [String: String]? {
        var out: [String: String] = [:]
        for part in q.split(separator: "&", omittingEmptySubsequences: true) {
            let pieces = part.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            guard let k = decode(String(pieces[0])) else { return nil }
            let v = pieces.count > 1 ? decode(String(pieces[1])) : ""
            guard let value = v else { return nil }
            if out[k] == nil { out[k] = value }
        }
        return out
    }

    private static func decode(_ s: String) -> String? {
        s.replacingOccurrences(of: "+", with: " ").removingPercentEncoding
    }
}
