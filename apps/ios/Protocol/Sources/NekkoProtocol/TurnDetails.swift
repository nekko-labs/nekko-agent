import Foundation

/// The host's persisted measurements for one turn. A narrow projection: never
/// retain arbitrary provider payloads, prompts, keys or future metadata fields.
public struct TurnStats: Equatable, Sendable {
    public let providerId: String
    public let modelId: String
    public let effort: String?
    public let inputTokens: Double
    public let outputTokens: Double
    public let cacheReadTokens: Double?
    public let cacheWriteTokens: Double?
    public let outputMs: Double?
    public let wallMs: Double
    public let calls: Double
    public let stop: String?

    public static func from(_ v: JSONValue?) -> TurnStats? {
        guard let v, let provider = v.str("providerId"), !provider.isEmpty,
              let model = v.str("modelId"), !model.isEmpty,
              let input = number(v, "inputTokens"), let output = number(v, "outputTokens"),
              let wall = number(v, "wallMs"), let calls = number(v, "calls") else { return nil }
        let effort = v.str("effort").flatMap { ["low", "medium", "normal", "high", "xhigh", "max"].contains($0) ? $0 : nil }
        let stop = v.str("stop").flatMap { ["complete", "loop", "runaway"].contains($0) ? $0 : nil }
        return TurnStats(providerId: provider, modelId: model, effort: effort, inputTokens: input, outputTokens: output,
                         cacheReadTokens: number(v, "cacheReadTokens"), cacheWriteTokens: number(v, "cacheWriteTokens"),
                         outputMs: number(v, "outputMs"), wallMs: wall, calls: calls, stop: stop)
    }

    private static func number(_ v: JSONValue, _ key: String) -> Double? {
        guard let n = v.dbl(key), n.isFinite, n >= 0 else { return nil }
        return n
    }

    /// `decodeRate` in shared/chat.ts. Wall time includes tools and approvals,
    /// so it must never be substituted for missing provider decode time.
    public var tokensPerSecond: Double? {
        guard let outputMs, outputMs >= 100, outputTokens > 0 else { return nil }
        let rate = outputTokens / (outputMs / 1000)
        return rate.isFinite && rate > 0 ? rate : nil
    }

    /// Only these counts and identifiers may follow a consented saved transcript.
    public var json: JSONValue {
        var o: [String: JSONValue] = [
            "providerId": .string(providerId), "modelId": .string(modelId),
            "inputTokens": .double(inputTokens), "outputTokens": .double(outputTokens),
            "wallMs": .double(wallMs), "calls": .double(calls),
        ]
        if let effort { o["effort"] = .string(effort) }
        if let stop { o["stop"] = .string(stop) }
        if let outputMs { o["outputMs"] = .double(outputMs) }
        if let cacheReadTokens { o["cacheReadTokens"] = .double(cacheReadTokens) }
        if let cacheWriteTokens { o["cacheWriteTokens"] = .double(cacheWriteTokens) }
        return .object(o)
    }
}

/// A footer belongs to the persisted message ending this turn, not to the
/// session's currently selected model or a transient `done` event.
public struct TurnDetails: Equatable, Sendable, Identifiable {
    public let id: String
    public let stats: TurnStats
    public let successful: Bool

    public init?(message: ChatMessage) {
        guard message.role == "assistant", let stats = message.turnStats else { return nil }
        id = message.id
        self.stats = stats
        successful = stats.stop == "complete" && !message.interrupted
    }

    /// Anchor after the message's last tool, including a textless tool-only
    /// message. Saved reply ids can be remapped to the live ids still on screen.
    public static func footers(_ messages: [ChatMessage], shownIds: [String: String] = [:]) -> [String: TurnDetails] {
        var out: [String: TurnDetails] = [:]
        for m in messages where m.role == "assistant" && m.turnStats != nil {
            let anchor = m.toolCalls.last?.id ?? m.id
            out[shownIds[anchor] ?? anchor] = TurnDetails(message: m)
        }
        return out
    }

    public var parts: [String] {
        var parts = [stats.modelId + " · " + stats.providerId]
        if let effort = stats.effort {
            parts.append((effort == "xhigh" ? "Extra high" : effort.capitalized) + " effort")
        }
        parts.append(Self.tokens(stats.inputTokens + (stats.cacheReadTokens ?? 0) + (stats.cacheWriteTokens ?? 0)) + " in")
        parts.append(Self.tokens(stats.outputTokens) + " out")
        if let rate = stats.tokensPerSecond { parts.append(String(format: rate >= 10 ? "%.0f tok/s" : "%.1f tok/s", rate)) }
        parts.append(String(format: "%.0fs", max(1, (stats.wallMs / 1000).rounded())))
        return parts
    }

    private static func tokens(_ n: Double) -> String {
        n >= 1000 ? String(format: n >= 10000 ? "%.0fk" : "%.1fk", n / 1000) : String(format: "%.0f", n)
    }
}
