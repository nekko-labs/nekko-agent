import Foundation
import NekkoKit
import NekkoProtocol
import Observation

/// Phone-only, non-secret preferences (UserDefaults). Each is a plain stored
/// property so SwiftUI observes it; writes persist immediately.
@MainActor
@Observable
final class Prefs {
    /// `theme` that follows the computer's preset, mode and accent, like Android.
    static let matchComputer = "computer"

    /// The preset a theme choice draws: its own, or the computer's when it matches the computer.
    static func preset(_ choice: String, computer: Appearance?) -> ThemePreset? {
        ThemePreset.find(choice == matchComputer ? computer?.preset : choice)
    }

    private let d: UserDefaults

    /// `matchComputer` or a desktop preset id (`system` follows this iPhone).
    var theme: String { didSet { d.set(theme, forKey: "theme") } }
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
    /// What the Live Activity card shows on the Lock Screen and in the Dynamic Island (None starts none).
    var liveActivityLevel: LiveLevel { didSet { d.set(liveActivityLevel.rawValue, forKey: "liveActivityLevel") } }
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
    /// Expert mode (2026-10-24): the chat adds the computer's hardware and loaded
    /// models to Simple mode's model, effort and context. Off by default.
    var expertMode: Bool { didSet { d.set(expertMode, forKey: "expertMode") } }
    /// Per computer, the last model chosen for a new chat: `providerId::modelId`.
    var lastModel: [String: String] { didSet { d.set(lastModel, forKey: "lastModel") } }
    /// How the chat list is grouped, sorted and what it shows (the desktop Agents panel's view menu).
    var chatListView: ChatListView { didSet { d.set(chatListView.encoded, forKey: "chatListView") } }
    /// Per computer, the project groups' order as dragged on this iPhone (folder ids and `ChatGroup.general`).
    var groupOrder: [String: [String]] { didSet { d.set(groupOrder, forKey: "groupOrder") } }
    /// Per computer, the two panes on a folding phone or iPad (`PaneLayout` JSON, FD-3). Never leaves this iPhone.
    var paneLayouts: [String: Data] { didSet { d.set(paneLayouts, forKey: "paneLayouts") } }
    /// The one-time tip offering *Chat + Chat* was shown.
    var paneTipShown: Bool { didSet { d.set(paneTipShown, forKey: "paneTipShown") } }
    /// The note that the panes were made without a foldable to test on was dismissed (on this device).
    var foldNoteDismissed: Bool { didSet { d.set(foldNoteDismissed, forKey: "foldNoteDismissed") } }

    init(defaults: UserDefaults = .standard) {
        d = defaults
        // bool(forKey:) also reads `-key YES|NO` launch arguments (UI tests).
        func flag(_ k: String, _ fallback: Bool) -> Bool { defaults.object(forKey: k) == nil ? fallback : defaults.bool(forKey: k) }
        theme = d.string(forKey: "theme").flatMap { $0 == Self.matchComputer || ThemePreset.find($0) != nil ? $0 : nil } ?? Self.matchComputer
        appLock = flag("appLock", true)
        hapticNeedsYou = flag("hapticNeedsYou", true)
        hapticDone = flag("hapticDone", false)
        // Before per-kind switches there was one, `notify`: its value is each one's default.
        let notify = flag("notify", true)
        notifyNeedsYou = flag("notifyNeedsYou", notify)
        notifyFinished = flag("notifyFinished", notify)
        notifyFailed = flag("notifyFailed", notify)
        // Before levels there was one switch, and app lock kept chat text off the Lock Screen.
        // The first level is stored, so turning app lock off later doesn't change it.
        if let level = defaults.string(forKey: "liveActivityLevel").flatMap(LiveLevel.init(rawValue:)) {
            liveActivityLevel = level
        } else {
            let first: LiveLevel = !flag("liveActivities", true) ? .none : flag("appLock", true) ? .minimal : .standard
            liveActivityLevel = first
            defaults.set(first.rawValue, forKey: "liveActivityLevel")
        }
        defaultComputer = d.string(forKey: "defaultComputer")
        dictationOnComputer = flag("dictationOnComputer", true)
        dictationHold = flag("dictationHold", false)
        onboarded = flag("onboarded", false)
        expertMode = flag("expertMode", false)
        lastModel = d.dictionary(forKey: "lastModel") as? [String: String] ?? [:]
        chatListView = ChatListView.parse(d.data(forKey: "chatListView"))
        groupOrder = d.dictionary(forKey: "groupOrder") as? [String: [String]] ?? [:]
        paneLayouts = d.dictionary(forKey: "paneLayouts") as? [String: Data] ?? [:]
        paneTipShown = flag("paneTipShown", false)
        foldNoteDismissed = flag("foldNoteDismissed", false)
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

    /// The panes last used with `computerId`, else the first-open default (*Chats + Chat*).
    func paneLayout(_ computerId: String?) -> PaneLayout {
        computerId.flatMap { PaneLayout.parse(paneLayouts[$0]) } ?? .standard
    }

    func setPaneLayout(_ layout: PaneLayout, for computerId: String?) {
        guard let computerId, let data = layout.encoded, paneLayouts[computerId] != data else { return }
        paneLayouts[computerId] = data
    }
}
