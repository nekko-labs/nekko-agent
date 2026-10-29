import Foundation

/// How hard a model works per turn (`EffortLevel`, packages/shared/src/settings.ts),
/// and which levels a model takes (`modelEffortLevels`, model-capabilities.ts).
public enum Effort: String, CaseIterable, Sendable {
    case low, medium, normal, high, xhigh, max

    /// The levels worth offering for a model, lowest first.
    public static func levels(for modelId: String) -> [Effort] {
        if usesNativeEffort(modelId) { return [.low, .medium, .high, .xhigh, .max] }
        return isOpenAIReasoning(modelId) ? [.low, .medium, .normal, .high] : [.low, .normal, .high]
    }

    /// General recommendation, independent of the computer's or phone's saved choice.
    public static func recommended(for modelId: String) -> Effort {
        guard usesNativeEffort(modelId) else { return .normal }
        if let c = claude(modelId), c.family == "opus", c.major > 5 || (c.major == 5 && c.minor >= 5) { return .medium }
        return .high
    }

    /// Match shared `effectiveEffort`: map a saved rung to one this model supports.
    public static func effective(_ setting: Effort?, for modelId: String) -> Effort {
        let level = setting ?? .normal
        if usesNativeEffort(modelId) { return level == .normal ? recommended(for: modelId) : level }
        if level == .xhigh || level == .max { return .high }
        if !isOpenAIReasoning(modelId) && level == .medium { return .normal }
        return level
    }

    /// Anthropic's `output_config.effort`: Claude from the 4.7 generation on, Fable and Mythos always.
    static func usesNativeEffort(_ modelId: String) -> Bool {
        guard let c = claude(modelId) else { return false }
        if c.family == "fable" || c.family == "mythos" { return true }
        return c.major > 4 || (c.major == 4 && c.minor >= 7)
    }

    static func isOpenAIReasoning(_ modelId: String) -> Bool {
        modelId.range(of: #"(?:^|[-_/ .])(?:o[134](?:-|$)|gpt-?(?:[5-9]|\d{2,})(?:[.\-]|$)|gpt-oss|codex)"#,
                      options: [.regularExpression, .caseInsensitive]) != nil
    }

    /// `parseClaudeModel`: a gateway's `vendor/` and Bedrock's `anthropic.` prefixes stripped.
    static func claude(_ modelId: String) -> (family: String, major: Int, minor: Int)? {
        var id = modelId.lowercased().trimmingCharacters(in: .whitespaces)
        if let slash = id.lastIndex(of: "/") { id = String(id[id.index(after: slash)...]) }
        if let at = id.range(of: "anthropic."), id[at.upperBound...].hasPrefix("claude-") { id = String(id[at.upperBound...]) }
        let re = try! NSRegularExpression(pattern: #"^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2})(?!\d))?"#)
        guard let m = re.firstMatch(in: id, range: NSRange(id.startIndex..., in: id)) else { return nil }
        func group(_ i: Int) -> String? { Range(m.range(at: i), in: id).map { String(id[$0]) } }
        return (group(1)!, Int(group(2)!)!, group(3).flatMap(Int.init) ?? 0)
    }
}
