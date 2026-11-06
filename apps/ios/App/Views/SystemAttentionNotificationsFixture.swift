#if DEBUG
import NekkoProtocol
import Observation
import SwiftUI
import UIKit
import UserNotifications

/// Opt-in system fixture for disposable simulators only. No AppModel, stores,
/// credentials, relay or APNs. The Notifier and OS delivery are production code.
/// NEKKO_ATTENTION_BASELINE only adapts the harness to the exact old Notifier API;
/// it never implements a badge writer or overrides notification presentation.
@MainActor
@Observable
final class SystemAttentionFixtureModel {
    let notifier = Notifier()
    var pending: Set<String> = []
    var reading = "Starting"
    var ready = false
    private let center = UNUserNotificationCenter.current()

    init() {
        #if !NEKKO_ATTENTION_BASELINE
        notifier.badgeCount = { [weak self] in self?.pending.count }
        #endif
    }

    func start() async {
        notifier.install()
        center.removeAllPendingNotificationRequests()
        center.removeAllDeliveredNotifications()
        ready = true
        while !Task.isCancelled {
            await inspect()
            do { try await Task.sleep(for: .milliseconds(200)) } catch { return }
        }
    }

    func authorize() async {
        _ = await notifier.requestPermission()
        await reconcile()
    }

    func reconcile() async {
        #if !NEKKO_ATTENTION_BASELINE
        notifier.reconcileBadge()
        await notifier.finishBadgeWrites()
        #endif
        await inspect()
    }

    func post(home: Bool = false) async {
        pending = ["active-chat", "fleet-chat"]
        await reconcile()
        let event = AgentEvent.from([
            "type": "tool_approval_required", "sessionId": home ? "fleet-chat" : "active-chat",
            "call": ["id": "fixture-approval", "name": "bash", "input": ["command": "swift test"]],
        ])!
        // Same call on both revisions. No synthetic UNNotificationRequest or OS UI.
        notifier.post(event, chatTitle: "Synthetic approval", computer: "Fixture Mac", hideContent: true)
        #if !NEKKO_ATTENTION_BASELINE
        await notifier.finishPosts()
        #endif
        await inspect()
    }

    func postFromHome() {
        // A bounded background lease lets the real immediate Notifier deliver
        // after XCTest presses Home, without altering production trigger behavior.
        let lease = UIApplication.shared.beginBackgroundTask(withName: "Attention evidence")
        Task {
            defer { UIApplication.shared.endBackgroundTask(lease) }
            do { try await Task.sleep(for: .seconds(3)) } catch { return }
            await post(home: true)
        }
    }

    func answerActive() async {
        pending.remove("active-chat")
        await Notifier.dismissNeedsYou(tag: E2E.activityTag("active-chat"))
        await reconcile()
    }

    func remoteDismiss() async {
        pending.remove("fleet-chat")
        await Notifier.dismissNeedsYou(tag: E2E.activityTag("fleet-chat"))
        await reconcile()
    }

    func clearDelivered() { center.removeAllDeliveredNotifications() }

    func inspect() async {
        let settings = await center.notificationSettings()
        let notes = await center.deliveredNotifications()
        let categories = await center.notificationCategories()
        let approval = notes.first { $0.request.content.categoryIdentifier == Notifier.approvalCategory }
        let actions = categories.first { $0.identifier == Notifier.approvalCategory }?.actions.map(\.identifier) ?? []
        let authorization = settings.authorizationStatus == .authorized ? "authorized" : "other"
        let badges = settings.badgeSetting == .enabled ? "enabled" : "disabled"
        // This OS readback supplements, not replaces, SpringBoard AX + screenshots.
        let badge = UIApplication.shared.applicationIconBadgeNumber
        reading = "authorization=\(authorization) badges=\(badges) pending=\(pending.count) osBadge=\(badge) delivered=\(notes.count) approval=\(approval != nil) actions=\(actions == [Notifier.allowAction, Notifier.denyAction]) local=\(approval != nil && approval?.request.trigger == nil) payloadBadge=\(approval?.request.content.badge != nil)"
    }
}

struct SystemAttentionNotificationsFixture: View {
    @State private var model = SystemAttentionFixtureModel()

    var body: some View {
        NavigationStack {
            List {
                Section("Disposable simulator only") {
                    Text("Real local notifications and Home Screen badge. Synthetic pending chats; no connections or saved data.")
                    Text("Viewing an unrelated chat")
                    Text(model.reading)
                        .font(.caption.monospaced())
                        .accessibilityIdentifier("system-attention-reading")
                }
                Section("Actions") {
                    Button("Grant notification permission") { Task { await model.authorize() } }
                    Button("Post foreground approval") { Task { await model.post() } }
                    Button("Post approval from Home") { model.postFromHome() }
                    Button("Answer active approval") { Task { await model.answerActive() } }
                    Button("Remote dismiss fleet question") { Task { await model.remoteDismiss() } }
                    Button("Clear delivered notifications") { model.clearDelivered() }
                }.disabled(!model.ready)
            }
            .navigationTitle("System attention fixture")
        }
        .task { await model.start() }
    }
}
#endif
