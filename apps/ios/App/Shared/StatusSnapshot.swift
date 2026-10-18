import Foundation

/// What the Home Screen and Lock Screen widgets show: counts, never chat titles
/// or tool details, so nothing private sits on a screen anyone can glance at.
/// The app writes it to the App Group whenever the counts change; the widget
/// only reads it. Compiled into both the app and the widget extension.
struct StatusSnapshot: Codable, Equatable {
    var computer: String?
    var online: Bool
    var needsYou: Int
    var running: Int
    var at: Date

    static let appGroup = "group.com.nekko.native.ios"
    static let key = "widget.status"
    static let kind = "NekkoStatus"

    static let empty = StatusSnapshot(computer: nil, online: false, needsYou: 0, running: 0, at: .distantPast)

    static func load(_ defaults: UserDefaults? = UserDefaults(suiteName: appGroup)) -> StatusSnapshot {
        guard let data = defaults?.data(forKey: key), let s = try? JSONDecoder().decode(StatusSnapshot.self, from: data) else { return .empty }
        return s
    }

    /// Saves and returns whether anything the widget shows changed.
    @discardableResult
    func save(_ defaults: UserDefaults? = UserDefaults(suiteName: StatusSnapshot.appGroup)) -> Bool {
        let previous = StatusSnapshot.load(defaults)
        guard let data = try? JSONEncoder().encode(self) else { return false }
        defaults?.set(data, forKey: StatusSnapshot.key)
        var same = previous
        same.at = at
        return same != self
    }

    /// The answer to "What needs me?" (Siri, Spotlight, Shortcuts): the same
    /// counts as the widget, in a sentence, with their age once it matters.
    func spoken(now: Date = Date()) -> String {
        guard let computer else { return "No computer is paired with Nekko Agent yet." }
        if at == .distantPast { return "Open Nekko Agent once so it can check \(computer)." }
        let chats = { (n: Int) in n == 1 ? "1 chat" : "\(n) chats" }
        var text: String
        if needsYou > 0 {
            text = "\(chats(needsYou)) \(needsYou == 1 ? "needs" : "need") you on \(computer)"
            if running > 0 { text += ", and \(running) \(running == 1 ? "is" : "are") working" }
            text += "."
        } else if running > 0 {
            text = "\(chats(running)) \(running == 1 ? "is" : "are") working on \(computer). Nothing needs you."
        } else {
            text = online ? "All quiet on \(computer)." : "\(computer) was offline when Nekko Agent last checked."
        }
        if now.timeIntervalSince(at) > 5 * 60 {
            let f = RelativeDateTimeFormatter()
            f.unitsStyle = .full
            text += " As of \(f.localizedString(for: at, relativeTo: now))."
        }
        return text
    }

    var headline: String {
        if computer == nil { return "Not paired" }
        if needsYou > 0 { return needsYou == 1 ? "1 needs you" : "\(needsYou) need you" }
        if running > 0 { return running == 1 ? "1 working" : "\(running) working" }
        return online ? "All quiet" : "Offline"
    }
}

/// The snapshot as it goes to the Apple Watch (WatchConnectivity application
/// context): the same counts and computer name the widget shows, nothing else.
extension StatusSnapshot {
    static let watchKey = "status"

    var watchContext: [String: Any] {
        guard let data = try? JSONEncoder().encode(self) else { return [:] }
        return [Self.watchKey: data]
    }

    init?(watchContext: [String: Any]) {
        guard let data = watchContext[Self.watchKey] as? Data,
              let s = try? JSONDecoder().decode(StatusSnapshot.self, from: data) else { return nil }
        self = s
    }
}
