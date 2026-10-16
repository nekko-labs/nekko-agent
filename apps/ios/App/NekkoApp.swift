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
