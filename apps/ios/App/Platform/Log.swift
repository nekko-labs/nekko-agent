import os

/// The app's unified logs, one `Logger` per area, for field bugs on TestFlight
/// that the in-app connection log can't show (it lives only while the app does):
/// background approvals, Live Activity tokens, push and background delivery.
/// Collect them with `log collect --device` and filter by subsystem in Console.
///
/// Interpolations are private by default (redacted in a collected log); only
/// values that are never personal (kinds, counts, outcomes) are `.public`, and
/// a chat is named by a hash of its id (`.private(mask: .hash)`), so one chat's
/// lines can be followed without showing which chat it is.
enum Log {
    static let subsystem = "dev.nekkolabs.nekkoagent"

    /// Allow / Deny from a notification or the Live Activity card.
    static let approval = Logger(subsystem: subsystem, category: "approval")
    /// The app's background time, background refresh and the outbox it delivers.
    static let background = Logger(subsystem: subsystem, category: "background")
    /// Push registration and Live Activity push tokens.
    static let push = Logger(subsystem: subsystem, category: "push")
}
