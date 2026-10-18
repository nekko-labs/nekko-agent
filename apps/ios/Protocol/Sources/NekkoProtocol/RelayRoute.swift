import Foundation

/// What kind of path a relay address is, and why it can't work from a phone,
/// said before or while it fails so "Connecting…" never spins without a reason.
///
/// The transport rule (TASKS.md PH1): `wss://` anywhere; plain `ws://` only
/// toward private networks, where something else already encrypts or confines
/// the hop: a Tailscale tailnet (WireGuard), the LAN, or loopback in the
/// simulator. Frames are E2E-sealed on every path; the rule is about not
/// leaking metadata to the open internet. The app's ATS exceptions
/// (`Info.plist`) match: `ts.net` names and local networking only.
public enum RelayRoute: Equatable, Sendable {
    /// A Tailscale MagicDNS name (`*.ts.net`) or a 100.64.0.0/10 address.
    case tailscale
    /// A private LAN address (RFC 1918, link-local, `.local`, IPv6 ULA).
    case lan
    /// `localhost`: the phone itself (the simulator reaches the Mac this way).
    case loopback
    /// Anything else: the hosted Nekko relay or a self-hosted public one.
    case internet

    public static func of(_ relayUrl: String) -> RelayRoute {
        let h = host(relayUrl)
        if h == "localhost" || h == "127.0.0.1" || h == "::1" || h.hasPrefix("127.") { return .loopback }
        if h == "ts.net" || h.hasSuffix(".ts.net") || isTailscaleIPv4(h) || isTailscaleIPv6(h) { return .tailscale }
        if h.hasSuffix(".local") || isPrivateIPv4(h) || isPrivateIPv6(h) { return .lan }
        return .internet
    }

    public enum Problem: Equatable, Sendable {
        /// `localhost` on a phone means the phone itself, not the computer.
        case loopback
        /// Plain `ws://` toward the open internet: refused (use `wss://`).
        case publicCleartext
    }

    /// The problem with `relayUrl` on this device, or nil when it can work.
    /// `simulator`: loopback reaches the Mac, so it is allowed there.
    public static func problem(_ relayUrl: String, simulator: Bool) -> Problem? {
        let route = of(relayUrl)
        if route == .loopback && !simulator { return .loopback }
        let cleartext = relayUrl.trimmingCharacters(in: .whitespaces).lowercased().hasPrefix("ws://")
        if cleartext && route == .internet { return .publicCleartext }
        return nil
    }

    public static func message(_ problem: Problem, computer: String) -> String {
        switch problem {
        case .loopback:
            return "\(computer)’s relay is set to this device itself (localhost). On \(computer): Settings → Remote access, use your Tailscale name or the Nekko relay, then pair again."
        case .publicCleartext:
            return "This relay is not encrypted (ws://) and is on the open internet. Use a wss:// relay, or your computer’s Tailscale name, then pair again."
        }
    }

    /// The host part of a ws/wss/http(s) URL, lowercased, IPv6 without brackets.
    public static func host(_ url: String) -> String {
        var s = url.trimmingCharacters(in: .whitespaces)
        if let r = s.range(of: "://") { s = String(s[r.upperBound...]) }
        if let at = s.firstIndex(of: "@") { s = String(s[s.index(after: at)...]) }
        if s.hasPrefix("[") {
            guard let end = s.firstIndex(of: "]") else { return "" }
            return String(s[s.index(after: s.startIndex)..<end]).lowercased()
        }
        return String(s.prefix { $0 != "/" && $0 != ":" && $0 != "?" && $0 != "#" }).lowercased()
    }

    static func ipv4(_ h: String) -> [Int]? {
        let parts = h.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return nil }
        let n = parts.compactMap { Int($0) }
        guard n.count == 4, n.allSatisfy({ (0...255).contains($0) }) else { return nil }
        return n
    }

    /// 100.64.0.0/10: Tailscale's CGNAT range.
    public static func isTailscaleIPv4(_ h: String) -> Bool {
        guard let n = ipv4(h) else { return false }
        return n[0] == 100 && (64...127).contains(n[1])
    }

    /// fd7a:115c:a1e0::/48: Tailscale's IPv6 range.
    static func isTailscaleIPv6(_ h: String) -> Bool { h.hasPrefix("fd7a:115c:a1e0:") }

    static func isPrivateIPv4(_ h: String) -> Bool {
        guard let n = ipv4(h) else { return false }
        return n[0] == 10 || (n[0] == 172 && (16...31).contains(n[1])) || (n[0] == 192 && n[1] == 168) || (n[0] == 169 && n[1] == 254)
    }

    static func isPrivateIPv6(_ h: String) -> Bool {
        guard h.contains(":") else { return false }
        return h.hasPrefix("fc") || h.hasPrefix("fd") || h.hasPrefix("fe80:")
    }
}
