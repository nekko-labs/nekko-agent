import Foundation

/// The one limit line under a chat's model (#2923): the provider's tightest window,
/// quiet below 75%, near from 75% (or when the provider warns), reached at 100% or when limited.
public struct LimitLine: Equatable, Sendable {
    public enum Level: Equatable, Sendable { case quiet, near, reached }

    public let window: ProviderLimits.Window
    public var level: Level {
        if window.limited || window.usedPercent >= 100 { return .reached }
        if window.status == "warning" || window.usedPercent >= 75 { return .near }
        return .quiet
    }
    /// Whole percent used, 0 to 100.
    public var percent: Int { Int(window.usedPercent.rounded()) }

    public init(window: ProviderLimits.Window) { self.window = window }

    /// Nothing when the provider reported no windows: no line, never a guess.
    public static func tightest(_ limits: ProviderLimits?) -> LimitLine? {
        guard let windows = limits?.windows, !windows.isEmpty else { return nil }
        let score = { (w: ProviderLimits.Window) in w.limited ? 101 : w.usedPercent }
        guard let worst = windows.max(by: { score($0) < score($1) }) else { return nil }
        return LimitLine(window: worst)
    }
}
