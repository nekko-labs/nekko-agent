import Foundation
import NekkoKit
import NekkoProtocol
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
    /// Notifications per kind (IO-30): an approval or a question, a finished
    /// reply, a failed one. Local ones while the app is in the background but
    /// still connected, and the relay pushes only these kinds.
    var notifyNeedsYou: Bool { didSet { d.set(notifyNeedsYou, forKey: "notifyNeedsYou") } }
    var notifyFinished: Bool { didSet { d.set(notifyFinished, forKey: "notifyFinished") } }
    var notifyFailed: Bool { didSet { d.set(notifyFailed, forKey: "notifyFailed") } }
    /// Show running turns on the Lock Screen and in the Dynamic Island.
    var liveActivities: Bool { didSet { d.set(liveActivities, forKey: "liveActivities") } }
    /// The computer to connect to at launch; nil = the one used last.
    var defaultComputer: String? { didSet { d.set(defaultComputer, forKey: "defaultComputer") } }
    /// Dictation: the computer's Whisper when installed, else this iPhone's recognizer.
    var dictationOnComputer: Bool { didSet { d.set(dictationOnComputer, forKey: "dictationOnComputer") } }
    /// Dictation: hold the microphone to talk and let go to stop (IO-28), instead of tap to start and tap to stop.
    var dictationHold: Bool { didSet { d.set(dictationHold, forKey: "dictationHold") } }
    /// The first run (IO-31) was finished or skipped; it never shows again.
    var onboarded: Bool { didSet { d.set(onboarded, forKey: "onboarded") } }
    /// Keep each computer's chat list (titles, times, folders) on this iPhone to show
    /// while the computer is unreachable. On unless the user turned it off (OF-9).
    /// Written only when the switch is flipped: the stored value is the user's choice.
    var keepChatList: Bool { didSet { d.set(keepChatList, forKey: "keepChatList") } }
    /// Keep the last chats opened (up to 20, 5 MB per computer, no photos) to read
    /// while the computer is unreachable (OF-5). On unless the user turned it off.
    var keepTranscripts: Bool { didSet { d.set(keepTranscripts, forKey: "keepTranscripts") } }
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
        // Before per-kind switches there was one, `notify`: its value is each one's default.
        let notify = flag("notify", true)
        notifyNeedsYou = flag("notifyNeedsYou", notify)
        notifyFinished = flag("notifyFinished", notify)
        notifyFailed = flag("notifyFailed", notify)
        liveActivities = flag("liveActivities", true)
        defaultComputer = d.string(forKey: "defaultComputer")
        dictationOnComputer = flag("dictationOnComputer", true)
        dictationHold = flag("dictationHold", false)
        onboarded = flag("onboarded", false)
        lastModel = d.dictionary(forKey: "lastModel") as? [String: String] ?? [:]
        // On unless the user turned them off: an install that never touched a switch has nothing stored.
        func choice(_ k: String) -> Bool? { defaults.object(forKey: k) == nil ? nil : defaults.bool(forKey: k) }
        keepChatList = OfflineSetting.isOn(stored: choice("keepChatList"))
        keepTranscripts = OfflineSetting.isOn(stored: choice("keepTranscripts"))
    }

    func wants(_ kind: PushKind) -> Bool {
        switch kind {
        case .needsYou: return notifyNeedsYou
        case .finished: return notifyFinished
        case .failed: return notifyFailed
        case .test: return true
        }
    }

    /// What the relay is asked to push.
    var pushKinds: [PushKind] { PushKind.choosable.filter(wants) }
}
