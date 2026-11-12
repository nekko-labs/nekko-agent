import Foundation
import NekkoProtocol

/// What the connection strip says about one paired computer, or about Tailscale
/// on this iPhone: a dot, at most one word, and (behind a tap) one line and its fixes.
/// Replaces the connection, fleet and protocol banners on the chat list.
public struct ConnectionNote: Equatable, Sendable, Identifiable {
    public enum Tone: Equatable, Sendable {
        /// Online.
        case ok
        /// Dialing, or waiting on something else (Tailscale): a hollow ring, no word.
        case waiting
        /// Not connected by choice (the computer's connection switch is off).
        case off
        case warning
        case danger
    }

    public enum Action: Equatable, Sendable {
        /// Dial now (the link keeps trying on its own anyway).
        case retry
        /// Remote access was turned back on at the computer after a safety exit: connect again.
        case tryAgain
        case pairAgain
        case openTailscale
        /// The Connection screen, with the full diagnosis (the active computer only).
        case details
    }

    /// The computer's id, or `ConnectionNote.tailscaleId`.
    public let id: String
    /// The computer's name, or nil for the Tailscale item.
    public let name: String?
    public let tone: Tone
    /// The one word beside the name when something is wrong ("offline").
    public let word: String?
    /// The colour of `word`; the dot's colour is `tone`.
    public let wordTone: Tone
    /// The one sentence shown when the item is opened; nil means there is nothing to open.
    public let line: String?
    /// A quieter second half of the sentence (how to fix it, what waits to send).
    public let tail: String?
    public let actions: [Action]
    /// Offer the safety exits (SK-8) beside the actions: the active computer only.
    public let more: Bool

    public static let tailscaleId = "tailscale"

    public var opens: Bool { line != nil }
    public var isTailscale: Bool { id == Self.tailscaleId }
}

/// One paired computer's connection, as the strip needs it.
public struct ConnectionFacts: Equatable, Sendable {
    public var id: String
    public var name: String
    public var route: RelayRoute
    public var relayHost: String
    public var state: RelayState
    public var detail: String?
    public var denied: DenyReason?
    /// The computer the phone's screens act on: it gets Details and the safety exits.
    public var active: Bool
    /// The connection switch is off (#2053): not a problem, the user chose it.
    public var disabled: Bool
    /// The active computer's protocol comparison (IO-32); `.same` for the others.
    public var protocolCheck: ProtocolCheck
    /// A safety exit this phone used on the computer (SK-8), and when (ms since the epoch).
    public var exit: SafetyExit.Kind?
    public var exitAt: Int64?
    /// Prompts written here that go when the computer is back.
    public var waiting: Int

    public init(id: String, name: String, route: RelayRoute = .internet, relayHost: String = "", state: RelayState,
                detail: String? = nil, denied: DenyReason? = nil, active: Bool = false, disabled: Bool = false,
                protocolCheck: ProtocolCheck = .same, exit: SafetyExit.Kind? = nil, exitAt: Int64? = nil, waiting: Int = 0) {
        self.id = id; self.name = name; self.route = route; self.relayHost = relayHost; self.state = state
        self.detail = detail; self.denied = denied; self.active = active; self.disabled = disabled
        self.protocolCheck = protocolCheck; self.exit = exit; self.exitAt = exitAt; self.waiting = waiting
    }
}

public enum ConnectionNotes {
    /// The strip's items: Tailscale first when it is what keeps computers away, then every computer in order.
    /// `time` formats a safety exit's moment (the app passes the locale's short time).
    public static func make(_ computers: [ConnectionFacts], tailscaleOn: Bool,
                            time: (Int64) -> String = { _ in "" }) -> [ConnectionNote] {
        let blocked = computers.filter { !$0.disabled && TailscaleApp.shouldOffer(route: $0.route, tailscaleOn: tailscaleOn, state: $0.state) }
        var out: [ConnectionNote] = []
        if !blocked.isEmpty {
            let names = joined(blocked.map(\.name))
            let waiting = blocked.reduce(0) { $0 + $1.waiting }
            out.append(ConnectionNote(id: ConnectionNote.tailscaleId, name: nil, tone: .warning, word: "Tailscale off", wordTone: .warning,
                                      line: "Turn on Tailscale to reach \(names).", tail: waitingTail(waiting),
                                      actions: [.openTailscale] + (blocked.contains(where: \.active) ? [.details] : []), more: false))
        }
        let blockedIds = Set(blocked.map(\.id))
        for c in computers {
            out.append(blockedIds.contains(c.id) ? quiet(c, .waiting) : note(c, time: time))
        }
        return out
    }

    /// "Studio", "Studio and Gomi", "Studio, Gomi and Laptop".
    static func joined(_ names: [String]) -> String {
        guard names.count > 1 else { return names.first ?? "" }
        return names.dropLast().joined(separator: ", ") + " and " + names[names.count - 1]
    }

    /// Only the items that have something to say: Files, Monitors.
    public static func problems(_ notes: [ConnectionNote]) -> [ConnectionNote] { notes.filter(\.opens) }

    private static func quiet(_ c: ConnectionFacts, _ tone: ConnectionNote.Tone) -> ConnectionNote {
        ConnectionNote(id: c.id, name: c.name, tone: tone, word: nil, wordTone: tone, line: nil, tail: nil, actions: [], more: false)
    }

    private static func waitingTail(_ n: Int) -> String? {
        n == 0 ? nil : n == 1 ? "1 prompt waits to send." : "\(n) prompts wait to send."
    }

    /// Joins a fix and what waits to send into the quieter half of the line.
    private static func tail(_ fix: String?, _ c: ConnectionFacts) -> String? {
        let parts = [fix, c.active ? waitingTail(c.waiting) : nil].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " ")
    }

    static func note(_ c: ConnectionFacts, time: (Int64) -> String) -> ConnectionNote {
        let name = c.name
        func problem(_ tone: ConnectionNote.Tone, _ word: String, _ line: String, _ fix: String?, _ actions: [ConnectionNote.Action]) -> ConnectionNote {
            ConnectionNote(id: c.id, name: name, tone: tone, word: word, wordTone: tone, line: line, tail: tail(fix, c),
                           actions: actions + (c.active ? [.details] : []), more: c.active)
        }
        if c.disabled { return quiet(c, .off) }
        // This iPhone ended the connection itself (SK-8): say so, not "offline".
        if let exit = c.exit, c.state != .online {
            let at = c.exitAt.map(time) ?? ""
            switch exit {
            case .stoppedRemote:
                return problem(.warning, "stopped", "You stopped remote access here\(at.isEmpty ? "" : " at \(at)").",
                               "Turn it on at \(name), then try again.", [.tryAgain])
            case .quit:
                return problem(.warning, "quit", "You quit Nekko Agent on \(name)\(at.isEmpty ? "" : " at \(at)").",
                               "Open it there; this phone keeps trying.", [])
            }
        }
        if c.detail == RelayStatus.badPairingKey || (c.state == .denied && (c.denied == .badKey || c.denied == .badCode)) {
            return problem(.danger, "key changed", "The pairing key no longer matches \(name).", "Pair again with a fresh code.", [.pairAgain])
        }
        switch c.state {
        case .online:
            switch c.protocolCheck {
            case .same: return quiet(c, .ok)
            case .updateComputer:
                return ConnectionNote(id: c.id, name: name, tone: .ok, word: "update", wordTone: .warning,
                                      line: "\(name) runs an older Nekko Agent.", tail: "Update it there to use everything here.",
                                      actions: [], more: false)
            case .updatePhone:
                return ConnectionNote(id: c.id, name: name, tone: .ok, word: "update", wordTone: .warning,
                                      line: "This app is older than Nekko Agent on \(name).", tail: "Update it from the App Store.",
                                      actions: [], more: false)
            }
        case .idle:
            return quiet(c, .off)
        case .connecting:
            if c.detail == RelayStatus.hostNotFound {
                return problem(.danger, "not found", "Can’t find \(c.relayHost.isEmpty ? "the relay" : c.relayHost).",
                               "Change how phones connect on \(name), then pair again.", [])
            }
            // Still dialing for the first time: nothing to say until it fails.
            guard c.detail != nil else { return quiet(c, .waiting) }
            if c.route == .tailscale {
                return problem(.warning, "no answer", "\(name) doesn’t answer on your tailnet.",
                               "Is it awake and signed in to the same tailnet?", [.retry, .openTailscale])
            }
            return problem(.warning, "no answer", "Can’t reach \(name) right now.", "This phone keeps trying.", [.retry])
        case .offline:
            return problem(.warning, "offline", "\(name) is offline.", "Open Nekko Agent on it, with Remote access on.", [.retry])
        case .denied:
            switch c.denied {
            case .updateRequired?:
                return problem(.danger, "update", "\(name) no longer accepts this app.", "Update it from the App Store.", [])
            case .revoked?, .kicked?:
                return problem(.danger, "refused", "\(name) removed this iPhone.", nil, [.pairAgain])
            default:
                return problem(.danger, "refused", "\(name) doesn’t know this iPhone any more.", nil, [.pairAgain])
            }
        }
    }
}

extension ComputersStore {
    /// Every paired computer's connection, in the store's order, for the strip.
    public var connectionFacts: [ConnectionFacts] {
        computers.map { c in
            let active = c.id == activeId
            let peer = peers[c.id]
            let exit = active ? safetyExit.flatMap { $0.computerId == c.id ? $0 : nil } : nil
            return ConnectionFacts(id: c.id, name: c.name, route: c.route, relayHost: c.relayHost,
                                   state: active ? conn : peer?.conn ?? .idle,
                                   detail: active ? connDetail : peer?.detail,
                                   denied: active ? denied : peer?.denied,
                                   active: active, disabled: c.connectionDisabled == true,
                                   protocolCheck: active ? protocolCheck : .same,
                                   exit: exit?.kind, exitAt: exit?.at, waiting: active ? outbox.count : 0)
        }
    }
}
