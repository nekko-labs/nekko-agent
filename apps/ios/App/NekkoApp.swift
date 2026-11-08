import NekkoKit
import SwiftUI
import UIKit

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        guard !NativeFixtureRoute.isolated else { return true }
        OutboxRefresh.register()
        // The folding-phone layout's hinge (none on today's iPhones; faked in the UI tests).
        Hinge.install()
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        guard !NativeFixtureRoute.isolated else { return }
        MainActor.assumeIsolated { AppModel.shared.didRegister(deviceToken: deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // Push is optional: the relay's content-free "finished" pings just won't arrive.
        Log.push.error("Push registration failed: \(error.localizedDescription, privacy: .public)")
    }

    /// The relay's silent push after an approval or a question was handled
    /// elsewhere: remove that chat's needs-you notification (IO-30).
    func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any]) async
        -> UIBackgroundFetchResult {
        guard !NativeFixtureRoute.isolated else { return .noData }
        let info = NativeNotificationInfo(userInfo)
        await AppModel.shared.receivedRemoteNotification(info)
        return info.dismiss == nil ? .noData : .newData
    }

    /// Only so the Home Screen quick action reaches the app (QuickActionScene).
    func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: nil, sessionRole: connectingSceneSession.role)
        config.delegateClass = QuickActionScene.self
        // A cold launch from the quick action: the item arrives with the connection.
        if let item = options.shortcutItem { QuickAction.perform(item.type) }
        return config
    }
}

/// Long-press the app icon → **New chat** (Info.plist `UIApplicationShortcutItems`),
/// the iPhone side of Android's launcher shortcut. It opens the same
/// `nekko-agent://new` link as the Control Center control; nothing is sent.
enum QuickAction {
    static let newChat = "dev.nekkolabs.nekkoagent.new-chat"

    /// The link a quick action opens, or nil for one this version doesn't know.
    static func url(for type: String) -> URL? {
        type == newChat ? URL(string: "nekko-agent://new") : nil
    }

    @discardableResult
    static func perform(_ type: String) -> Bool {
        guard !NativeFixtureRoute.isolated, let url = url(for: type) else { return false }
        MainActor.assumeIsolated { AppModel.shared.handle(url: url) }
        return true
    }
}

final class QuickActionScene: NSObject, UIWindowSceneDelegate {
    func windowScene(_ windowScene: UIWindowScene, performActionFor shortcutItem: UIApplicationShortcutItem,
                     completionHandler: @escaping (Bool) -> Void) {
        completionHandler(QuickAction.perform(shortcutItem.type))
    }
}

@main
@MainActor
struct NekkoApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        WindowGroup {
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("-uiTestSystemAttentionNotifications") {
                SystemAttentionNotificationsFixture()
            } else if ProcessInfo.processInfo.arguments.contains("-uiTestAttentionNotifications") {
                AttentionNotificationsFixture()
            } else { NativeAppContent() }
            #else
            NativeAppContent()
            #endif
        }
    }
}

/// Debug routes which must not start real transports or lifecycle work.
enum NativeFixtureRoute {
    static var isolated: Bool {
        #if DEBUG
        let flags = ["-uiTestComputerSettingsEvidence", "-uiTestChatRefresh", "-uiTestNewChat", "-uiTestMarkdownLab", "-uiTestChatStatus",
                     "-uiTestPurposeGroups", "-uiTestReplyVoices", "-uiTestModelTabs",
                     "-uiTestTurnDetails", "-uiTestAttentionNotifications", "-uiTestSystemAttentionNotifications",
                     "-uiTestSecurityEvidence", "-uiTestRunSettings"]
        return flags.contains { ProcessInfo.processInfo.arguments.contains($0) }
        #else
        return false
        #endif
    }
}

@MainActor
private struct NativeAppContent: View {
    @Environment(\.scenePhase) private var phase
    @State private var app = AppModel.shared
    /// The opening animation: in full at launch (once past the app lock), its dissolve on every return to the app.
    @State private var splash: SplashView.Kind? = Self.splashOn ? .launch : nil
    /// Each showing of the animation, so a finished one never clears a newer one.
    @State private var splashRun = 0
    /// UI tests turn it off (`-splash NO`, or a `-uiTestReset` run).
    private static let splashOn = !NativeFixtureRoute.isolated && (UserDefaults.standard.object(forKey: "splash") as? Bool
        ?? !ProcessInfo.processInfo.arguments.contains("-uiTestReset"))

    private var spooky: Bool { Prefs.preset(app.prefs.theme, computer: app.store.appearance)?.isSpooky == true }

    /// The app, or (Debug builds) a fixture the UI tests photograph.
    @ViewBuilder private var root: some View {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-uiTestComputerSettingsEvidence") { ComputerSettingsEvidenceFixture() } else
        if ProcessInfo.processInfo.arguments.contains("-uiTestVoiceConversation") { VoiceConversationFixture() } else
        if ProcessInfo.processInfo.arguments.contains("-uiTestPhoneComposer") { PhoneComposerFixture() } else
        if ProcessInfo.processInfo.arguments.contains("-uiTestPhoneParity") { PhoneParityFixture() } else
        if ProcessInfo.processInfo.arguments.contains("-uiTestModelServer") { ModelServerFixture() } else
        if ProcessInfo.processInfo.arguments.contains("-uiTestRunSettings") { RunSettingsFixture() } else
        if ProcessInfo.processInfo.arguments.contains("-uiTestPhotoPreviews") {
            PhotoPreviewFixture()
        } else if ProcessInfo.processInfo.arguments.contains("-uiTestChatRefresh") {
            ChatRefreshFixture()
        } else if ProcessInfo.processInfo.arguments.contains("-uiTestNewChat") {
            NewChatFixture()
        } else if ProcessInfo.processInfo.arguments.contains("-uiTestMarkdownLab") {
            MarkdownLab()
        } else if ProcessInfo.processInfo.arguments.contains("-uiTestChatStatus") {
            ChatStatusFixture()
        } else if ProcessInfo.processInfo.arguments.contains("-uiTestPurposeGroups") {
            PurposeGroupsFixture()
        } else if ProcessInfo.processInfo.arguments.contains("-uiTestReplyVoices") {
            ReplyVoicesFixture()
        } else if ProcessInfo.processInfo.arguments.contains("-uiTestTurnDetails") {
            TurnDetailsFixture()
        } else if ProcessInfo.processInfo.arguments.contains("-uiTestModelTabs") {
            ModelTabsFixture()
        } else if ProcessInfo.processInfo.arguments.contains("-uiTestFirstPromptIntro") {
            FirstPromptIntroFixture()
        } else if ProcessInfo.processInfo.arguments.contains("-uiTestSecurityEvidence") {
            SecurityEvidenceFixture()
        } else { RootView() }
        #else
        RootView()
        #endif
    }

    var body: some View {
        root
            .environment(app)
            .environment(app.store)
            .environment(app.cloud)
            .environment(app.phone)
            .environment(app.connectors)
            .environment(app.prefs)
            .modifier(Themed(choice: app.prefs.theme, appearance: app.store.appearance))
            .onOpenURL { app.handle(url: $0) }
            .task {
                guard !NativeFixtureRoute.isolated else { return }
                #if DEBUG
                // These fixtures skip the transports but keep the rest of the lifecycle, as on main.
                if ["-uiTestVoiceConversation", "-uiTestPhoneParity", "-uiTestPhoneComposer", "-uiTestPhotoPreviews"]
                    .contains(where: ProcessInfo.processInfo.arguments.contains) { return }
                #endif
                app.start()
            }
            .overlay {
                if let kind = splash {
                    let run = splashRun
                    SplashView(kind: kind, ready: phase == .active && !(app.prefs.appLock && app.lock.locked)) {
                        if splashRun == run { splash = nil }
                    }
                    .id(run)
                }
            }
            .task(id: spooky) { if !NativeFixtureRoute.isolated { SpookyIcon.sync(spooky: spooky) } }
        .onChange(of: phase) { _, p in
            guard !NativeFixtureRoute.isolated else { return }
            switch p {
            case .active:
                app.didBecomeActive()
                // The season may have ended since the last open.
                SpookyIcon.sync(spooky: spooky)
            case .background:
                app.didEnterBackground()
                // Put the cat up while away, so the return opens on it rather than flashing the list first.
                // With the app lock on, the lock cover is this same cat and plays the dissolve itself.
                if Self.splashOn && !app.prefs.appLock {
                    splashRun += 1
                    splash = .resume
                }
            default: break
            }
        }
    }
}
