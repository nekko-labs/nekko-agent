import Foundation
import LocalAuthentication
import Observation

/// Face ID / Touch ID / passcode on every open and every return, like
/// Android's app lock. While locked the UI shows a cover and the app does not
/// open the relay connection until the first unlock.
@MainActor
@Observable
final class AppLock {
    private(set) var locked: Bool
    /// The app has been open this launch: unlocked once, or started with the lock off.
    private(set) var everUnlocked: Bool
    private(set) var error: String?
    private(set) var authenticating = false

    init(enabled: Bool) {
        locked = enabled
        everUnlocked = !enabled
    }

    /// The app left the screen.
    func didEnterBackground(enabled: Bool) {
        if enabled { locked = true }
    }

    func unlock(reason: String = "Unlock Nekko Agent") async {
        guard locked, !authenticating else { return }
        authenticating = true
        defer { authenticating = false }
        let ctx = LAContext()
        var e: NSError?
        // Device owner authentication falls back to the passcode; a phone with
        // no passcode at all can't be protected, so it just opens.
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &e) else {
            locked = false
            everUnlocked = true
            return
        }
        do {
            if try await ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) {
                locked = false
                everUnlocked = true
                error = nil
            }
        } catch {
            self.error = (error as? LAError)?.code == .userCancel ? nil : error.localizedDescription
        }
    }

    /// Turning the lock off is itself protected.
    func confirmDisable() async -> Bool {
        let ctx = LAContext()
        var e: NSError?
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &e) else { return true }
        return (try? await ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Turn off the app lock")) ?? false
    }

    func disable() {
        locked = false
        everUnlocked = true
    }
}
