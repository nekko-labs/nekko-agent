import Foundation
import NekkoProtocol

/// The warning before YOLO (decision 0054): YOLO never asks, so the egress
/// gate that asks before data leaves a chat that read the web or a tool is
/// off too. The desktop's `YoloWarning.tsx`; on the phone the "Don't warn me
/// again" choice stays on this device (`skipKey` in UserDefaults).
public enum YoloWarning {
    /// UserDefaults key: true once "Don't warn me again" was ticked.
    public static let skipKey = "skipYoloWarning"

    /// Warn only when moving to YOLO from another mode, and not after "Don't warn me again".
    public static func needed(from current: PcSettings.ChatMode?, to next: PcSettings.ChatMode, skipped: Bool) -> Bool {
        next == .yolo && current != .yolo && !skipped
    }
}
