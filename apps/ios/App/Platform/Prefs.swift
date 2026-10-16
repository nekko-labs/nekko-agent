import Foundation
import Observation

/// Phone-only, non-secret preferences (UserDefaults). Each is a plain stored
/// property so SwiftUI observes it; writes persist immediately.
@MainActor
@Observable
final class Prefs {
    enum ThemeChoice: String, CaseIterable, Identifiable {
        /// Follow the computer's theme (light/dark/system and accent), like Android.
        case computer, system, light, dark
        var id: String { rawValue }
        var label: String {
            switch self {
            case .computer: return "Match my computer"
            case .system: return "Match this iPhone"
            case .light: return "Light"
            case .dark: return "Dark"
            }
        }
    }

    private let d: UserDefaults

    var theme: ThemeChoice { didSet { d.set(theme.rawValue, forKey: "theme") } }
    /// Face ID / passcode on every open and every return. On by default.
    var appLock: Bool { didSet { d.set(appLock, forKey: "appLock") } }
    /// Haptics for approvals and questions (on), and for finished turns (off).
    var hapticNeedsYou: Bool { didSet { d.set(hapticNeedsYou, forKey: "hapticNeedsYou") } }
    var hapticDone: Bool { didSet { d.set(hapticDone, forKey: "hapticDone") } }
    /// Local notifications while the app is in the background but still connected.
    var notify: Bool { didSet { d.set(notify, forKey: "notify") } }
    /// Show running turns on the Lock Screen and in the Dynamic Island.
    var liveActivities: Bool { didSet { d.set(liveActivities, forKey: "liveActivities") } }
    /// The computer to connect to at launch; nil = the one used last.
    var defaultComputer: String? { didSet { d.set(defaultComputer, forKey: "defaultComputer") } }
    /// Dictation: the computer's Whisper when installed, else this iPhone's recognizer.
    var dictationOnComputer: Bool { didSet { d.set(dictationOnComputer, forKey: "dictationOnComputer") } }
    /// Per computer, the last model chosen for a new chat: `providerId::modelId`.
    var lastModel: [String: String] { didSet { d.set(lastModel, forKey: "lastModel") } }

    init(defaults: UserDefaults = .standard) {
        d = defaults
        // bool(forKey:) also reads `-key YES|NO` launch arguments (UI tests).
        func flag(_ k: String, _ fallback: Bool) -> Bool { defaults.object(forKey: k) == nil ? fallback : defaults.bool(forKey: k) }
        theme = ThemeChoice(rawValue: d.string(forKey: "theme") ?? "") ?? .computer
        appLock = flag("appLock", true)
        hapticNeedsYou = flag("hapticNeedsYou", true)
        hapticDone = flag("hapticDone", false)
        notify = flag("notify", true)
        liveActivities = flag("liveActivities", true)
        defaultComputer = d.string(forKey: "defaultComputer")
        dictationOnComputer = flag("dictationOnComputer", true)
        lastModel = d.dictionary(forKey: "lastModel") as? [String: String] ?? [:]
    }
}
