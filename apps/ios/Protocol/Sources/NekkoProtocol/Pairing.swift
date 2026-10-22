import Foundation

/// Pairing links. Settings → Remote access on the computer shows a QR carrying
/// `nekko-agent-pair:?relay=&room=&key=&pair=` (or, from the Local Web UI,
/// `https://host/?relay=…`), plus one `alt=` per extra route to the same relay
/// (the relay on the computer's LAN addresses, TASKS.md IO-20). Either form, or
/// a bare query string, parses to the same credentials. Mirrors
/// `packages/shared/src/pairing-link.ts`, held to it by `Fixtures/pairing-links.json`,
/// as are Android's `Pairing.kt` and the Expo app's `pairing.ts`.
public struct PairingLink: Equatable, Sendable, CustomStringConvertible {
    public let relayUrl: String
    public let room: String
    /// Pairing secret. Never logged.
    public let key: String
    /// One-time enrollment code; absent when re-using an existing pairing.
    public let pair: String?
    /// Other addresses of the same relay, in the link's order.
    public let alts: [String]

    public init(relayUrl: String, room: String, key: String, pair: String? = nil, alts: [String] = []) {
        self.relayUrl = relayUrl
        self.room = room
        self.key = key
        self.pair = pair
        self.alts = alts
    }

    /// Never print the secret.
    public var description: String { "PairingLink(relay=\(relayUrl), room=\(room), pair=\(pair != nil), alts=\(alts.count))" }
}

public enum Pairing {
    /// At most this many `alt` routes are kept (`MAX_PAIRING_ALTS`).
    public static let maxAlts = 4

    public static func parse(_ input: String) -> PairingLink? {
        let raw = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if raw.isEmpty { return nil }
        var query = raw
        if let q = raw.firstIndex(of: "?") { query = String(raw[raw.index(after: q)...]) }
        if let h = query.firstIndex(of: "#") { query = String(query[..<h]) }
        guard let pairs = parseQuery(query) else { return nil }
        func first(_ k: String) -> String? { pairs.first { $0.0 == k }?.1 }
        let relay = (first("relay") ?? "").trimmingCharacters(in: .whitespaces)
        let room = (first("room") ?? "").trimmingCharacters(in: .whitespaces)
        let key = (first("key") ?? "").trimmingCharacters(in: .whitespaces)
        guard !relay.isEmpty, !room.isEmpty, !key.isEmpty else { return nil }
        let lower = relay.lowercased()
        guard lower.hasPrefix("ws://") || lower.hasPrefix("wss://") else { return nil }
        guard isHex(room, 8...128), isHex(key, 16...256) else { return nil }
        var pair = first("pair")?.trimmingCharacters(in: .whitespaces).uppercased()
        if pair?.isEmpty == true { pair = nil }
        let url = trimSlashes(relay)
        return PairingLink(relayUrl: url, room: room, key: key, pair: pair,
                           alts: alts(pairs.filter { $0.0 == "alt" }.map(\.1), relayUrl: url))
    }

    /// The usable `alt` values: PH1-clean, no trailing slashes, no repeats of the relay or each other.
    public static func alts(_ values: [String], relayUrl: String) -> [String] {
        var out: [String] = []
        for v in values {
            let url = trimSlashes(v.trimmingCharacters(in: .whitespaces))
            if url.isEmpty || !usable(url) || url == relayUrl || out.contains(url) { continue }
            out.append(url)
            if out.count == maxAlts { break }
        }
        return out
    }

    /// Relay host for display ("relay.nekkoagent.com", "studio.tail1234.ts.net:4400").
    public static func relayHost(_ relayUrl: String) -> String {
        var s = relayUrl
        if let r = s.range(of: "://") { s = String(s[r.upperBound...]) }
        return String(s.prefix { $0 != "/" })
    }

    /// `relayUrlProblem` is nil: a ws(s) address with a host, and plain `ws://` only off the open internet.
    static func usable(_ url: String) -> Bool {
        let lower = url.lowercased()
        let rest: Substring
        if lower.hasPrefix("wss://") { rest = lower.dropFirst(6) } else if lower.hasPrefix("ws://") { rest = lower.dropFirst(5) } else { return false }
        guard let c = rest.first, !"/?#".contains(c) else { return false }
        return lower.hasPrefix("wss://") || RelayRoute.of(url) != .internet
    }

    private static func trimSlashes(_ s: String) -> String {
        var url = s
        while url.hasSuffix("/") { url.removeLast() }
        return url
    }

    private static func isHex(_ s: String, _ len: ClosedRange<Int>) -> Bool {
        len.contains(s.count) && s.allSatisfy { $0.isHexDigit && $0.isASCII }
    }

    /// URLSearchParams semantics: every pair in order (the first wins for a single value), `+` is a space.
    private static func parseQuery(_ q: String) -> [(String, String)]? {
        var out: [(String, String)] = []
        for part in q.split(separator: "&", omittingEmptySubsequences: true) {
            let pieces = part.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            guard let k = decode(String(pieces[0])) else { return nil }
            let v = pieces.count > 1 ? decode(String(pieces[1])) : ""
            guard let value = v else { return nil }
            out.append((k, value))
        }
        return out
    }

    private static func decode(_ s: String) -> String? {
        s.replacingOccurrences(of: "+", with: " ").removingPercentEncoding
    }
}
