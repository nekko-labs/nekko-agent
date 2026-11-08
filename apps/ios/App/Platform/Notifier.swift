import Foundation
import NekkoKit
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
    /// An MCP tool's approval: Allow, Always allow this tool, Deny (decision 0054).
    nonisolated static let mcpApprovalCategory = "nekko.approval.mcp"
    nonisolated static let allowAction = "nekko.allow"
    nonisolated static let alwaysAllowAction = "nekko.alwaysAllow"
    nonisolated static let denyAction = "nekko.deny"
    /// `userInfo` key on the note that says an answer did not reach the computer.
    nonisolated static let unsentKey = "unsent"

    var onApprove: ((_ sessionId: String, _ callId: String, _ allow: Bool) async -> Void)?
    /// "Always allow this tool": opens the chat, whose card saves the tool and allows the call.
    var onAlwaysAllow: ((_ sessionId: String, _ callId: String) -> Void)?
    var onOpen: ((_ sessionId: String) -> Void)?
    var onFocusComputer: ((String) -> Void)?
    var onOpenTag: ((String) -> Void)?
    var onRemote: ((NativeNotificationInfo) -> Void)?
    var wants: (PushKind) -> Bool = { _ in true }
    /// Read at submission time, never an enqueued per-computer count. Nil leaves APNs alone.
    var badgeCount: () -> Int? = { nil }
    private let delivery: NotificationDelivery
    private var badgeWrite: Task<Void, Never>?

    init(delivery: NotificationDelivery? = nil) {
        self.delivery = delivery ?? SystemNotificationDelivery()
        super.init()
    }

    func reconcileBadge() {
        let previous = badgeWrite
        badgeWrite = Task { [weak self] in
            await previous?.value
            guard let self else { return }
            let permission = await self.delivery.permission()
            guard permission.badges, let count = self.badgeCount() else { return }
            do { try await self.delivery.setBadge(count) }
            catch { Log.push.error("Badge update failed: \(error.localizedDescription, privacy: .public)") }
        }
    }

    /// Test seam: wait for serialized badge submissions, not APNs device delivery.
    func finishBadgeWrites() async { await badgeWrite?.value }

    private var postWrite: Task<Void, Never>?
    func finishPosts() async { await postWrite?.value }

    private func submit(_ content: UNMutableNotificationContent, identifier: String, trigger: UNNotificationTrigger? = nil) {
        let previous = postWrite
        postWrite = Task {
            await previous?.value
            let permission = await delivery.permission()
            let kind = (content.userInfo["kind"] as? String).flatMap(PushKind.init(rawValue:))
            guard permission.allowed, kind.map({ wants($0) }) ?? true else { return }
            if !permission.sound { content.sound = nil }
            // Local notifications never carry a captured badge. One serial writer owns local counts.
            content.badge = nil
            try? await delivery.add(UNNotificationRequest(identifier: identifier, content: content, trigger: trigger))
        }
    }

    private var lastPosted: [String: Date] = [:]

    func install() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.setNotificationCategories(Self.categories())
    }

    /// Allow / Deny on an approval; an MCP tool's adds "Always allow this tool".
    nonisolated static func categories() -> Set<UNNotificationCategory> {
        let allow = UNNotificationAction(identifier: Self.allowAction, title: "Allow", options: [.authenticationRequired])
        let deny = UNNotificationAction(identifier: Self.denyAction, title: "Deny", options: [.destructive])
        // Opens the app: saving the tool for the chat is signed with Face ID or the
        // passcode (a guarded option), which can't run behind a notification.
        let always = UNNotificationAction(identifier: Self.alwaysAllowAction, title: String(localized: "Always allow this tool"),
                                          options: [.foreground, .authenticationRequired])
        return [
            UNNotificationCategory(identifier: Self.approvalCategory, actions: [allow, deny], intentIdentifiers: [], options: []),
            UNNotificationCategory(identifier: Self.mcpApprovalCategory, actions: [allow, always, deny], intentIdentifiers: [], options: []),
        ]
    }

    /// Asked after the first pairing, never at launch.
    func requestPermission() async -> Bool {
        (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
    }

    func post(_ e: AgentEvent, chatTitle: String, computer: String, hideContent: Bool, computerId: String = "") {
        guard let kind = PushKind.of(e) else { return }
        let content = UNMutableNotificationContent()
        content.threadIdentifier = e.sessionId
        content.userInfo = ["sessionId": e.sessionId, "kind": kind.rawValue, "tag": E2E.activityTag(e.sessionId), "computerId": computerId]
        content.title = hideContent ? computer : chatTitle
        switch e {
        case .approvalRequired(_, let a):
            content.body = hideContent ? "A tool needs your approval." : "Approve? \(Transcript.toolLabel(a.call))"
            content.categoryIdentifier = ChatModel.offersAlwaysAllow(a.call) ? Self.mcpApprovalCategory : Self.approvalCategory
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
        let key = "\(computerId):\(e.sessionId):\(content.categoryIdentifier):\(content.body)"
        if let last = lastPosted[key], Date().timeIntervalSince(last) < 5 { return }
        lastPosted[key] = Date()
        submit(content, identifier: "\(computerId).\(e.sessionId).\(UUID().uuidString)")
    }

    /// *Send a test notification* when the relay can't push: shown by the app, in a second.
    func postTest(computer: String) {
        let content = UNMutableNotificationContent()
        content.title = "Nekko Agent"
        content.body = "Test notification: \(computer) reached this iPhone."
        content.sound = .default
        content.userInfo = ["kind": PushKind.test.rawValue]
        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 1, repeats: false)
        submit(content, identifier: "nekko.test.\(UUID().uuidString)", trigger: trigger)
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
        submit(content, identifier: "\(sessionId).unsent.\(UUID().uuidString)")
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
        let info = NativeNotificationInfo(notification.request.content.userInfo)
        return await presentation(info, remote: notification.request.trigger is UNPushNotificationTrigger)
    }


    func presentation(_ info: NativeNotificationInfo, remote: Bool) -> UNNotificationPresentationOptions {
        if remote { onRemote?(info) }
        let kind = info.kind.flatMap(PushKind.init(rawValue:))
        guard kind.map({ wants($0) }) ?? true else { return [] }
        // There is no opened-chat tracker. Attention must still reach someone
        // viewing an unrelated chat. Finished replies remain quiet in foreground.
        let shown = kind == .needsYou || kind == .test || info.unsent
        return shown ? [.banner, .list, .sound] : []
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = NativeNotificationInfo(response.notification.request.content.userInfo)
        if response.notification.request.trigger is UNPushNotificationTrigger { await remoteReceived(info) }
        guard let sid = info.sessionId else {
            if let tag = info.tag { await openTag(tag) }
            return
        }
        if let computerId = info.computerId { await focusComputer(computerId) }
        let callId = info.callId
        let action = response.actionIdentifier
        if let callId, action == Self.alwaysAllowAction {
            await alwaysAllow(sid, callId)
        } else if let callId, action == Self.allowAction || action == Self.denyAction {
            // Awaited, not detached: returning tells iOS the action is handled, and
            // a backgrounded app may be suspended right after, mid-answer.
            await answer(sid, callId, allow: action == Self.allowAction)
        } else {
            await open(sid)
        }
    }

    private func remoteReceived(_ info: NativeNotificationInfo) { onRemote?(info) }
    private func focusComputer(_ id: String) { onFocusComputer?(id) }
    private func openTag(_ tag: String) { onOpenTag?(tag) }

    private func answer(_ sessionId: String, _ callId: String, allow: Bool) async {
        await onApprove?(sessionId, callId, allow)
    }

    private func open(_ sessionId: String) { onOpen?(sessionId) }
    private func alwaysAllow(_ sessionId: String, _ callId: String) { onAlwaysAllow?(sessionId, callId) }
}

enum Haptics {
    @MainActor static func needsYou() { UINotificationFeedbackGenerator().notificationOccurred(.warning) }
    @MainActor static func done() { UINotificationFeedbackGenerator().notificationOccurred(.success) }
    @MainActor static func tap() { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
}
