import Foundation
import NekkoProtocol

/// What this iPhone's own chats used (#1773): tokens per provider, model and
/// day, as each provider's stream reported them. Kept in a file of its own on
/// the phone beside the chats, never sent anywhere, and deleted by Forget
/// everything. The phone has no price table, so it counts tokens only.
public struct PhoneUsageLedger: Codable, Equatable, Sendable {
    public struct Entry: Codable, Equatable, Sendable {
        public let providerId: String
        /// The provider's name when it was used, so a removed provider still reads.
        public var providerLabel: String
        public let model: String
        /// The local day, `yyyy-MM-dd`, as a computer's summary dates its days.
        public let day: String
        public var input: Int64
        public var output: Int64
    }

    public private(set) var entries: [Entry] = []

    /// Days kept: older entries go when a new one is recorded.
    static let keepDays = 90
    /// Days the Usage screen lists, as a computer's summary sends.
    static let shownDays = 14

    public init(entries: [Entry] = []) { self.entries = entries }

    public var isEmpty: Bool { entries.isEmpty }

    /// Add one reply's tokens.
    public mutating func record(providerId: String, providerLabel: String, model: String, input: Int64, output: Int64, at ms: Int64,
                                calendar: Calendar = .current) {
        guard input > 0 || output > 0 else { return }
        let day = Self.day(ms, calendar: calendar)
        if let i = entries.firstIndex(where: { $0.providerId == providerId && $0.model == model && $0.day == day }) {
            entries[i].input += input
            entries[i].output += output
            entries[i].providerLabel = providerLabel
        } else {
            entries.append(Entry(providerId: providerId, providerLabel: providerLabel, model: model, day: day, input: input, output: output))
        }
        let oldest = Self.day(ms - Int64(Self.keepDays) * 86_400_000, calendar: calendar)
        entries.removeAll { $0.day < oldest }
    }

    /// The ledger as a place on the Usage screen: every model is pay-per-token, under its provider.
    public func place(name: String = "", online: Bool = true) -> UsagePlace {
        var groups: [UsagePlace.ApiGroup] = []
        for providerId in orderedProviders() {
            let mine = entries.filter { $0.providerId == providerId }
            var byModel: [String: (Int64, Int64)] = [:]
            for e in mine { byModel[e.model, default: (0, 0)].0 += e.input; byModel[e.model, default: (0, 0)].1 += e.output }
            let models = byModel.map { UsageSummary.Model(model: $0.key, input: $0.value.0, output: $0.value.1) }
                .sorted { $0.tokens != $1.tokens ? $0.tokens > $1.tokens : $0.model < $1.model }
            groups.append(UsagePlace.ApiGroup(label: mine.last?.providerLabel ?? providerId, models: models))
        }
        var byDay: [String: Int64] = [:]
        for e in entries { byDay[e.day, default: 0] += e.input + e.output }
        let days = byDay.keys.sorted().suffix(Self.shownDays).map { UsageSummary.Day(date: $0, tokens: byDay[$0] ?? 0) }
        let input = entries.reduce(0) { $0 + $1.input }
        let output = entries.reduce(0) { $0 + $1.output }
        let summary = UsageSummary(totalInput: input, totalOutput: output, totalCost: 0,
                                   models: groups.flatMap(\.models), days: Array(days))
        return UsagePlace(id: PhoneProviders.computerId, kind: .phone, name: name, online: online,
                          summary: entries.isEmpty ? nil : summary, phoneGroups: groups)
    }

    /// Providers, the busiest first.
    private func orderedProviders() -> [String] {
        var tokens: [String: Int64] = [:]
        for e in entries { tokens[e.providerId, default: 0] += e.input + e.output }
        return tokens.keys.sorted { tokens[$0]! != tokens[$1]! ? tokens[$0]! > tokens[$1]! : $0 < $1 }
    }

    static func day(_ ms: Int64, calendar: Calendar) -> String {
        let c = calendar.dateComponents([.year, .month, .day], from: Date(timeIntervalSince1970: Double(ms) / 1000))
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }
}
