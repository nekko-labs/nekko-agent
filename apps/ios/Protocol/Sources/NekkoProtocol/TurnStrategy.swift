/// The computer's admitted mode for one persisted user turn, not evidence of tool calls or delegation.
public struct TurnStrategy: Hashable, Sendable {
    public enum Tools: String, Sendable {
        case code, list, none
        case claudeCode = "claude-code"
    }

    public enum Orchestration: String, Sendable {
        case direct, coordinator, worker, external
    }

    public enum Reason: String, Sendable {
        case notNeeded = "not-needed"
        case requested, separable, unavailable, off
    }

    public let tools: Tools
    public let orchestration: Orchestration
    public let reason: Reason?
    public let modelId: String?
    public let subagentModelId: String?
    public let subagentsDeferred: Bool

    public static func from(_ v: JSONValue?) -> TurnStrategy? {
        guard let v, let tools = v.str("tools").flatMap(Tools.init(rawValue:)),
              let orchestration = v.str("orchestration").flatMap(Orchestration.init(rawValue:)) else { return nil }
        return TurnStrategy(tools: tools, orchestration: orchestration, reason: v.str("reason").flatMap(Reason.init(rawValue:)),
                            modelId: v.str("modelId"), subagentModelId: v.str("subagentModelId"),
                            subagentsDeferred: v["subagentsDeferred"] == .bool(true))
    }

    public var json: JSONValue {
        var out: [String: JSONValue] = ["tools": .string(tools.rawValue), "orchestration": .string(orchestration.rawValue)]
        if let reason { out["reason"] = .string(reason.rawValue) }
        if let modelId { out["modelId"] = .string(modelId) }
        if let subagentModelId { out["subagentModelId"] = .string(subagentModelId) }
        if subagentsDeferred { out["subagentsDeferred"] = .bool(true) }
        return .object(out)
    }

    /// Match each admitted strategy to its user prompt’s visible ID.
    public static func sections(_ messages: [ChatMessage], shownIds: [String: String] = [:]) -> [String: TurnStrategy] {
        var out: [String: TurnStrategy] = [:]
        for message in messages where message.role == "user" {
            guard let strategy = message.turnStrategy else { continue }
            out[shownIds[message.id] ?? message.id] = strategy
        }
        return out
    }
}
