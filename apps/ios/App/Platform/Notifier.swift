import Foundation
import NekkoProtocol
import UIKit
import UserNotifications

/// Local notifications for events that arrive while the app is in the
/// background but still connected, with Allow / Deny right on an approval.
/// Remote pushes from the relay are content-free ("a run finished") by design;
/// these local ones are built on the phone from the decrypted event, and say
/// less when the app lock is on.
@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    static let approvalCategory = "nekko.approval"
    static let allowAction = "nekko.allow"
    static let denyAction = "nekko.deny"

    var onApprove: ((_ sessionId: String, _ callId: String, _ allow: Bool) async -> Void)?
    var onOpen: ((_ sessionId: String) -> Void)?
    private var lastPosted: [String: Date] = [:]

    func install() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        let allow = UNNotificationAction(identifier: Self.allowAction, title: "Allow", options: [.authenticationRequired])
        let deny = UNNotificationAction(identifier: Self.denyAction, title: "Deny", options: [.destructive])
        center.setNotificationCategories([
            UNNotificationCategory(identifier: Self.approvalCategory, actions: [allow, deny], intentIdentifiers: [], options: []),
        ])
    }

    /// Asked after the first pairing, never at launch.
    func requestPermission() async -> Bool {
        (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
    }

    func post(_ e: AgentEvent, chatTitle: String, computer: String, hideContent: Bool) {
        let content = UNMutableNotificationContent()
        content.threadIdentifier = e.sessionId
        content.userInfo = ["sessionId": e.sessionId]
        content.title = hideContent ? computer : chatTitle
        switch e {
        case .approvalRequired(_, let a):
            content.body = hideContent ? "A tool needs your approval." : "Approve? \(Transcript.toolLabel(a.call))"
            content.categoryIdentifier = Self.approvalCategory
            content.userInfo["callId"] = a.call.id
            content.interruptionLevel = .timeSensitive
            content.sound = .default
        case .question(_, let q):
            content.body = hideContent ? "Your computer has a question." : (q.questions.first?.question ?? "A question for you.")
            content.interruptionLevel = .timeSensitive
            content.sound = .default
        case .done:
            content.body = "Finished on \(computer)."
        case .error(_, let message):
            if ["stopped", "aborted"].contains(message.lowercased()) { return }
            content.body = hideContent ? "Stopped with an error." : message
        default:
            return
        }
        // One notification per chat and kind at most every few seconds.
        let key = "\(e.sessionId):\(content.categoryIdentifier):\(content.body)"
        if let last = lastPosted[key], Date().timeIntervalSince(last) < 5 { return }
        lastPosted[key] = Date()
        let req = UNNotificationRequest(identifier: "\(e.sessionId).\(UUID().uuidString)", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(req)
    }

    func clear(sessionId: String) {
        let center = UNUserNotificationCenter.current()
        center.getDeliveredNotifications { list in
            let ids = list.filter { $0.request.content.threadIdentifier == sessionId }.map(\.request.identifier)
            center.removeDeliveredNotifications(withIdentifiers: ids)
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async
        -> UNNotificationPresentationOptions {
        // In the app the chat itself shows it.
        []
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        guard let sid = info["sessionId"] as? String else { return }
        let callId = info["callId"] as? String
        let action = response.actionIdentifier
        await MainActor.run {
            if let callId, action == Self.allowAction || action == Self.denyAction {
                let allow = action == Self.allowAction
                Task { await self.onApprove?(sid, callId, allow) }
            } else {
                self.onOpen?(sid)
            }
        }
    }
}

enum Haptics {
    @MainActor static func needsYou() { UINotificationFeedbackGenerator().notificationOccurred(.warning) }
    @MainActor static func done() { UINotificationFeedbackGenerator().notificationOccurred(.success) }
    @MainActor static func tap() { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
}
