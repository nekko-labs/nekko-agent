import NekkoKit
import SwiftUI
import UIKit

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        MainActor.assumeIsolated { AppModel.shared.didRegister(deviceToken: deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // Push is optional: the relay's content-free "finished" pings just won't arrive.
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
    static let newChat = "com.nekko.native.ios.new-chat"

    /// The link a quick action opens, or nil for one this version doesn't know.
    static func url(for type: String) -> URL? {
        type == newChat ? URL(string: "nekko-agent://new") : nil
    }

    @discardableResult
    static func perform(_ type: String) -> Bool {
        guard let url = url(for: type) else { return false }
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
    @Environment(\.scenePhase) private var phase
    @State private var app = AppModel.shared

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(app)
                .environment(app.store)
                .environment(app.prefs)
                .modifier(Themed(choice: app.prefs.theme, appearance: app.store.appearance))
                .onOpenURL { app.handle(url: $0) }
                .task { app.start() }
        }
        .onChange(of: phase) { _, p in
            switch p {
            case .active: app.didBecomeActive()
            case .background: app.didEnterBackground()
            default: break
            }
        }
    }
}
