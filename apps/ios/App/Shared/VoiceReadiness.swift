import Foundation

/// Whether the card's Talk to Nekko can open the microphone without a prompt. iOS
/// holds a permission prompt asked from the Lock Screen until the app opens, so the
/// card offers **Allow microphone** instead (it opens the app, which asks at once)
/// until the app has seen the permission granted. The app writes it to the App Group
/// (`AppModel.publishVoiceReadiness`); the widget extension only reads it.
/// Compiled into both the app and the widget extension.
enum VoiceReadiness {
    static let key = "card.micGranted"

    /// Unknown (never written) reads as ready: the intent still checks and hands off.
    static func micGranted(_ defaults: UserDefaults? = UserDefaults(suiteName: StatusSnapshot.appGroup)) -> Bool {
        defaults?.object(forKey: key) as? Bool ?? true
    }

    /// Saves and returns whether it changed.
    @discardableResult
    static func save(micGranted: Bool, _ defaults: UserDefaults? = UserDefaults(suiteName: StatusSnapshot.appGroup)) -> Bool {
        guard let defaults else { return false }
        let before = defaults.object(forKey: key) as? Bool
        guard before != micGranted else { return false }
        defaults.set(micGranted, forKey: key)
        return true
    }
}
