import Foundation
import UserNotifications

struct NotificationPermission: Equatable {
    var allowed: Bool
    var badges: Bool
    var sound: Bool
}

/// Injectable so fixtures and unit tests never change real notification settings or badges.
@MainActor
protocol NotificationDelivery: AnyObject {
    func permission() async -> NotificationPermission
    func add(_ request: UNNotificationRequest) async throws
    func setBadge(_ count: Int) async throws
}

@MainActor
final class SystemNotificationDelivery: NotificationDelivery {
    func permission() async -> NotificationPermission {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        let allowed = [.authorized, .provisional, .ephemeral].contains(settings.authorizationStatus)
        return .init(allowed: allowed, badges: allowed && settings.badgeSetting == .enabled,
                     sound: allowed && settings.soundSetting == .enabled)
    }
    func add(_ request: UNNotificationRequest) async throws {
        try await UNUserNotificationCenter.current().add(request)
    }
    func setBadge(_ count: Int) async throws {
        try await UNUserNotificationCenter.current().setBadgeCount(count)
    }
}

/// Extract primitives before crossing from a notification delegate to the main actor.
struct NativeNotificationInfo: Sendable {
    let sessionId: String?
    let callId: String?
    let computerId: String?
    let tag: String?
    let dismiss: String?
    let kind: String?
    let unsent: Bool

    init(_ info: [AnyHashable: Any]) {
        sessionId = info["sessionId"] as? String
        callId = info["callId"] as? String
        computerId = info["computerId"] as? String
        tag = info["tag"] as? String
        dismiss = info["dismiss"] as? String
        kind = info["kind"] as? String
        unsent = info["unsent"] as? Bool ?? false
    }
}
