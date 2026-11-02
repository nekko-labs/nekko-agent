import Foundation

/// What happened to this phone's connection to a computer, newest last, for the
/// Connection screen. Memory only, bounded, and content-free: states, the
/// relay client's own detail ("handshake timed out") and deny reasons. Never
/// rooms, keys, codes or anything a chat said.
public struct ConnectionLog: Equatable, Sendable {
    public struct Entry: Equatable, Sendable, Identifiable {
        public let id: Int
        public let at: Date
        public let state: RelayState
        public let detail: String?
        public let denied: DenyReason?
        /// The relay host, when the computer has several routes (IO-20).
        public var via: String? = nil
        /// How many times in a row this same state and detail came in (retries).
        public var repeats: Int
    }

    public static let capacity = 50

    public private(set) var entries: [Entry] = []
    private var nextId = 0

    public init() {}

    /// Adds a status; the same state and detail again only bumps the last entry's count.
    /// `via`: the relay host the state is about, when the computer has more than one route.
    public mutating func record(_ state: RelayState, detail: String? = nil, denied: DenyReason? = nil, via: String? = nil,
                                at: Date = Date()) {
        if var last = entries.last, last.state == state, last.detail == detail, last.denied == denied, last.via == via {
            last.repeats += 1
            entries[entries.count - 1] = last
            return
        }
        entries.append(Entry(id: nextId, at: at, state: state, detail: detail, denied: denied, via: via, repeats: 1))
        nextId += 1
        if entries.count > Self.capacity { entries.removeFirst(entries.count - Self.capacity) }
    }

    public mutating func clear() { entries = [] }

    /// When the connection was last online, if it has been since the log started.
    public var lastOnline: Date? { entries.last { $0.state == .online }?.at }

    /// The log as plain text to paste into a bug report: times, states and details only.
    public func text(relayHost: String, route: RelayRoute) -> String {
        let f = ISO8601DateFormatter()
        var lines = ["Relay: \(relayHost) (\(route))"]
        for e in entries {
            var line = "\(f.string(from: e.at)) \(e.state.rawValue)"
            if let d = e.denied { line += " [\(d.rawValue)]" }
            if let v = e.via { line += " via \(v)" }
            if let d = e.detail, e.denied == nil { line += " – \(Diagnostics.redact(d))" }
            if e.repeats > 1 { line += " ×\(e.repeats)" }
            lines.append(line)
        }
        return lines.joined(separator: "\n")
    }
}

/// What to try, given where the phone is trying to go and how it's going.
/// Most likely fix first; empty when nothing is wrong.
public enum ConnectionAdvice {
    public static func advise(route: RelayRoute, relayHost: String, computer: String, state: RelayState,
                              denied: DenyReason?, detail: String?, tailscaleOn: Bool) -> [String] {
        switch state {
        case .online, .idle:
            return []
        case .denied:
            switch denied {
            case .revoked?, .kicked?:
                return ["\(computer) removed this iPhone. Pair again: Settings → Remote access → Pair a device on the computer."]
            case .badCode?:
                return ["That pairing code was used or expired (codes last 10 minutes and work once). Make a new one on \(computer)."]
            case .badKey?:
                return ["The pairing key no longer matches \(computer), usually because remote access was turned off and on there. Pair again."]
            case .updateRequired?:
                return ["Update Nekko Agent on this phone: \(computer) no longer accepts older apps. Then open it again; no new pairing is needed."]
            default:
                return ["\(computer) doesn’t know this iPhone. Pair again from Settings → Remote access on the computer."]
            }
        case .offline:
            return [
                "The relay answers, but \(computer) isn’t connected to it. Wake \(computer) and open Nekko Agent with Remote access on.",
                "If \(computer) is awake, check it uses the same relay: Settings → Remote access shows it.",
            ]
        case .connecting:
            if detail == RelayStatus.hostNotFound {
                return [
                    "\(relayHost) doesn’t exist anymore, so this iPhone can’t reach \(computer) through it.",
                    "On \(computer), open Settings → Remote access, change how phones connect (Tailscale works with nothing hosted), then pair this iPhone again.",
                ]
            }
            var out: [String] = []
            switch route {
            case .tailscale:
                if !tailscaleOn {
                    out.append("Tailscale is off on this iPhone. Open the Tailscale app and connect to your tailnet.")
                } else {
                    out.append("Tailscale is on, but \(relayHost) doesn’t answer. Check \(computer) is awake and signed in to the same tailnet.")
                    out.append("On \(computer), Settings → Remote access → Relay on this computer should say it’s running.")
                }
            case .lan:
                out.append("\(relayHost) is on a local network. This iPhone must be on the same Wi-Fi, and Local Network access must be allowed for Nekko Agent in iOS Settings → Privacy.")
                if !tailscaleOn { out.append("Away from home, use Tailscale or the Nekko relay instead.") }
            case .loopback:
                out.append("This relay is this device itself, which only works in the simulator.")
            case .internet:
                out.append("Check this iPhone is online, then that \(relayHost) is up.")
                if let d = detail, d.localizedCaseInsensitiveContains("cert") || d.localizedCaseInsensitiveContains("tls") {
                    out.append("The relay’s certificate was refused. A self-hosted relay needs a valid TLS certificate.")
                }
            }
            return out
        }
    }
}
