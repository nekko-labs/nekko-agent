import Foundation

/// A computer that says it runs Nekko Agent on this network (TASKS.md PH3),
/// read from its `_nekko-agent._tcp` Bonjour TXT record. The record holds only
/// a name, a version and, when the computer runs its own relay, that relay's
/// address; never anything that lets a phone into the room. So a listing is
/// a pointer ("open Remote access on Studio and scan its code"), not a pairing.
public struct NearbyComputer: Equatable, Sendable, Identifiable {
    public static let serviceType = "_nekko-agent._tcp"
    /// The TXT version this app reads; other versions are skipped, not misread.
    static let version = "1"
    static let maxName = 63

    /// The Bonjour instance name, unique on the network.
    public let id: String
    public let name: String
    /// The computer's own relay (Relay on this computer), when it says one and
    /// this phone could use it; nil otherwise.
    public let relayUrl: String?

    public init(id: String, name: String, relayUrl: String?) {
        self.id = id
        self.name = name
        self.relayUrl = relayUrl
    }

    /// Nil for a record from another version, or one with nothing to show.
    public static func from(instance: String, txt: [String: String]) -> NearbyComputer? {
        guard txt["v"] == version else { return nil }
        let name = clean(txt["name"] ?? "").nonEmpty ?? clean(instance).nonEmpty
        guard let name else { return nil }
        return NearbyComputer(id: instance, name: name, relayUrl: usableRelay(txt["relay"]))
    }

    /// Anyone on the network can write this record, so the relay is shown only
    /// when it is a ws/wss address this phone would accept anyway.
    static func usableRelay(_ raw: String?) -> String? {
        guard let raw = raw?.trimmingCharacters(in: .whitespaces), !raw.isEmpty else { return nil }
        let lower = raw.lowercased()
        guard lower.hasPrefix("ws://") || lower.hasPrefix("wss://"), !RelayRoute.host(raw).isEmpty else { return nil }
        guard RelayRoute.problem(raw, simulator: false) == nil else { return nil }
        return raw
    }

    /// Printable, one line, at most [maxName] characters.
    static func clean(_ s: String) -> String {
        let scalars = s.unicodeScalars.map { CharacterSet.controlCharacters.contains($0) ? " " : Character($0) }
        let line = String(scalars).split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return String(line.prefix(maxName))
    }

    /// Newest names first is meaningless here; sort by name so the list holds still.
    public static func sorted(_ list: [NearbyComputer]) -> [NearbyComputer] {
        list.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }
}

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}
