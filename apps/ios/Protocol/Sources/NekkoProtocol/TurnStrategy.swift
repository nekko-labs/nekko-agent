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

    public static func from(_ v: JSONValue?) -> TurnStrategy? {
        guard let v, let tools = v.str("tools").flatMap(Tools.init(rawValue:)),
              let orchestration = v.str("orchestration").flatMap(Orchestration.init(rawValue:)) else { return nil }
        return TurnStrategy(tools: tools, orchestration: orchestration, reason: v.str("reason").flatMap(Reason.init(rawValue:)))
    }

    public var json: JSONValue {
        var out: [String: JSONValue] = ["tools": .string(tools.rawValue), "orchestration": .string(orchestration.rawValue)]
        if let reason { out["reason"] = .string(reason.rawValue) }
        return .object(out)
    }

    /// Place a section at the first known mode and at later mode changes.
    /// Missing metadata neither adds a section nor resets the last known mode. Reasons are not displayed.
    public static func sections(_ messages: [ChatMessage], shownIds: [String: String] = [:]) -> [String: TurnStrategy] {
        var previous: TurnStrategy?
        var out: [String: TurnStrategy] = [:]
        for message in messages where message.role == "user" {
            guard let strategy = message.turnStrategy,
                  strategy.tools != previous?.tools || strategy.orchestration != previous?.orchestration else { continue }
            out[shownIds[message.id] ?? message.id] = strategy
            previous = strategy
        }
        return out
    }
}
