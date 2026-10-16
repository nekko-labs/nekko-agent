import Foundation

/// Text another app shared with Nekko (the share sheet): a page link, a
/// selection, a note. It only ever pre-fills a new chat; nothing is sent until
/// the user presses Start. Same rules as Android's `share/SharedText.kt`.
public enum SharedText {
    /// Longer shares are cut here (a whole article shared by mistake should not stall the composer).
    public static let maxCharacters = 20_000

    /// Appended when a share was cut at `maxCharacters`.
    public static let cutNote = "\n\n[…shortened by Nekko: the shared text was longer than 20,000 characters]"

    /// The prompt to pre-fill, or nil when there is nothing usable. Safari
    /// shares the page title alongside the link; the title is kept above the
    /// text unless the text already contains it.
    public static func from(text: String?, subject: String?) -> String? {
        let body = clean(text)
        let title = clean(subject).flatMap { t in body.map { $0.contains(t) } == true ? nil : t }
        let joined = [title, body].compactMap { $0 }.joined(separator: "\n\n")
        guard !joined.isEmpty else { return nil }
        // Counted in characters (grapheme clusters), so an emoji is never split.
        guard joined.count > maxCharacters else { return joined }
        return String(joined.prefix(maxCharacters)).trimmingTrailingWhitespace() + cutNote
    }

    private static func clean(_ s: String?) -> String? {
        guard let s else { return nil }
        let unix = s.replacingOccurrences(of: "\r\n", with: "\n")
        // Control characters other than newline and tab never belong in a prompt.
        let kept = unix.unicodeScalars.filter { $0 == "\n" || $0 == "\t" || $0.properties.generalCategory != .control }
        let out = String(String.UnicodeScalarView(kept)).trimmingCharacters(in: .whitespacesAndNewlines)
        return out.isEmpty ? nil : out
    }
}

/// Hands shared text from the share extension to the app. The extension can't
/// open the app (Apple allows that only for a few extension types), so the
/// text waits in the App Group's defaults until the app next comes to the
/// front, for at most `lifetime`, and is removed as soon as the app reads it.
public struct ShareInbox {
    /// How long a share waits for the app to open.
    public static let lifetime: TimeInterval = 10 * 60

    private static let textKey = "share.text"
    private static let atKey = "share.at"
    private let defaults: UserDefaults

    public init(defaults: UserDefaults) {
        self.defaults = defaults
    }

    /// A new share replaces one that was never used.
    public func offer(_ text: String, now: Date = Date()) {
        defaults.set(text, forKey: Self.textKey)
        defaults.set(now.timeIntervalSince1970, forKey: Self.atKey)
    }

    /// The waiting text, once: it is removed whether or not it was still fresh.
    public func take(now: Date = Date()) -> String? {
        let text = defaults.string(forKey: Self.textKey)
        let at = defaults.double(forKey: Self.atKey)
        clear()
        guard let text, !text.isEmpty else { return nil }
        let age = now.timeIntervalSince1970 - at
        return age >= 0 && age <= Self.lifetime ? text : nil
    }

    /// Whether a share is waiting (without taking it).
    public var hasText: Bool { defaults.string(forKey: Self.textKey) != nil }

    public func clear() {
        defaults.removeObject(forKey: Self.textKey)
        defaults.removeObject(forKey: Self.atKey)
    }
}

private extension String {
    func trimmingTrailingWhitespace() -> String {
        var s = Substring(self)
        while let last = s.last, last.isWhitespace { s.removeLast() }
        return String(s)
    }
}
