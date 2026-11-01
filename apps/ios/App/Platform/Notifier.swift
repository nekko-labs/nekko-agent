import Foundation
import NekkoProtocol
import UIKit
import UserNotifications

/// Local notifications for events that arrive while the app is in the
/// background but still connected, with Allow / Deny right on an approval.
/// Remote pushes from the relay are content-free ("a run finished") by design;
/// these local ones are built on the phone from the decrypted event, and say
/// less when the app lock is on. Every one, local or pushed, carries its kind
/// (`PushKind`) and the chat's opaque tag, so a needs-you notification can be
/// removed once it was handled anywhere (IO-30 dismissal sync).
@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    nonisolated static let approvalCategory = "nekko.approval"
    nonisolated static let allowAction = "nekko.allow"
    nonisolated static let denyAction = "nekko.deny"
    /// `userInfo` key on the note that says an answer did not reach the computer.
    nonisolated static let unsentKey = "unsent"

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
        guard let kind = PushKind.of(e) else { return }
        let content = UNMutableNotificationContent()
        content.threadIdentifier = e.sessionId
        content.userInfo = ["sessionId": e.sessionId, "kind": kind.rawValue, "tag": E2E.activityTag(e.sessionId)]
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

    /// *Send a test notification* when the relay can't push: shown by the app, in a second.
    func postTest(computer: String) {
        let content = UNMutableNotificationContent()
        content.title = "Nekko Agent"
        content.body = "Test notification: \(computer) reached this iPhone."
        content.sound = .default
        content.userInfo = ["kind": PushKind.test.rawValue]
        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 1, repeats: false)
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "nekko.test.\(UUID().uuidString)", content: content, trigger: trigger))
    }

    /// An Allow or Deny from outside the app did not reach the computer: say so,
    /// so the tool does not wait on an answer the user believes they gave. A tap
    /// opens the chat, where the approval card still waits.
    func postUnsent(sessionId: String, allow: Bool, why: String) {
        let content = UNMutableNotificationContent()
        content.threadIdentifier = sessionId
        content.title = allow ? "Allow not sent" : "Deny not sent"
        content.body = "\(why) Open the chat to answer again."
        content.sound = .default
        content.interruptionLevel = .timeSensitive
        content.userInfo = ["sessionId": sessionId, Self.unsentKey: true]
        let req = UNNotificationRequest(identifier: "\(sessionId).unsent.\(UUID().uuidString)", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(req)
    }

    /// Whether notifications are allowed; asks when it was never asked (only after pairing).
    func ensurePermission() async -> Bool {
        switch await UNUserNotificationCenter.current().notificationSettings().authorizationStatus {
        case .authorized, .provisional, .ephemeral: return true
        case .notDetermined: return await requestPermission()
        default: return false
        }
    }

    /// The approval or question for this chat was handled (here, on the computer
    /// or on another device): its needs-you notifications go, local or pushed.
    nonisolated static func dismissNeedsYou(tag: String) async {
        let center = UNUserNotificationCenter.current()
        let ids = await center.deliveredNotifications().filter { n in
            let info = n.request.content.userInfo
            return info["tag"] as? String == tag && info["kind"] as? String == PushKind.needsYou.rawValue
        }.map(\.request.identifier)
        if !ids.isEmpty { center.removeDeliveredNotifications(withIdentifiers: ids) }
    }

    func clear(sessionId: String) {
        Task {
            let center = UNUserNotificationCenter.current()
            let ids = await center.deliveredNotifications().filter { $0.request.content.threadIdentifier == sessionId }.map(\.request.identifier)
            center.removeDeliveredNotifications(withIdentifiers: ids)
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async
        -> UNNotificationPresentationOptions {
        // A test is the one shown over the app: it was asked for here. Otherwise
        // the chat itself shows it. An unsent answer shows too: the user may be on
        // another screen, and the card they answered from is gone.
        let info = notification.request.content.userInfo
        let shown = info["kind"] as? String == PushKind.test.rawValue || info[Self.unsentKey] != nil
        return shown ? [.banner, .list, .sound] : []
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        guard let sid = info["sessionId"] as? String else { return }
        let callId = info["callId"] as? String
        let action = response.actionIdentifier
        if let callId, action == Self.allowAction || action == Self.denyAction {
            // Awaited, not detached: returning tells iOS the action is handled, and
            // a backgrounded app may be suspended right after, mid-answer.
            await answer(sid, callId, allow: action == Self.allowAction)
        } else {
            await open(sid)
        }
    }

    private func answer(_ sessionId: String, _ callId: String, allow: Bool) async {
        await onApprove?(sessionId, callId, allow)
    }

    private func open(_ sessionId: String) { onOpen?(sessionId) }
}

enum Haptics {
    @MainActor static func needsYou() { UINotificationFeedbackGenerator().notificationOccurred(.warning) }
    @MainActor static func done() { UINotificationFeedbackGenerator().notificationOccurred(.success) }
    @MainActor static func tap() { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
}
