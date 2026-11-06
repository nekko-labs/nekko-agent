#if DEBUG
import NekkoKit
import NekkoProtocol
import Observation
import SwiftUI
import UserNotifications

/// No AppModel, keychain, defaults, file stores, sockets or system notification center.
/// The real Notifier writes to a recorder; macOS CI can inspect deterministic native UI.
@MainActor
@Observable
final class AttentionFixtureDelivery: NotificationDelivery {
    var allowed = true
    var requests: [UNNotificationRequest] = []
    var badges: [Int] = []
    func permission() async -> NotificationPermission { .init(allowed: allowed, badges: allowed, sound: allowed) }
    func add(_ request: UNNotificationRequest) async throws { requests.append(request) }
    func setBadge(_ count: Int) async throws { badges.append(count) }
}

@MainActor
@Observable
final class AttentionNotificationsFixtureModel {
    var active = AttentionState()
    var fleet = AttentionState()
    var enabled = true
    var opened = "An unrelated chat"
    let delivery = AttentionFixtureDelivery()
    let notifier: Notifier
    private var seeded = false

    var count: Int? {
        guard let a = active.count, let b = fleet.count else { return nil }
        return a + b
    }

    init() {
        notifier = Notifier(delivery: delivery)
        notifier.badgeCount = { [weak self] in
            guard let self else { return nil }
            return self.enabled ? self.count : 0
        }
        notifier.wants = { [weak self] kind in kind != .needsYou || self?.enabled == true }
    }

    func seed() async {
        guard !seeded else { return }
        seeded = true
        active.replace([:], ticket: active.beginSnapshot())
        fleet.replace([:], ticket: fleet.beginSnapshot())
        let flags = ProcessInfo.processInfo.arguments
        delivery.allowed = !flags.contains("-attentionDenied")
        enabled = !flags.contains("-attentionDisabled")
        if !flags.contains("-attentionZero") {
            let approval = AgentEvent.from(["type": "tool_approval_required", "sessionId": "active-chat",
                                            "call": ["id": "tool", "name": "bash", "input": ["command": "swift test"]]])!
            let question = AgentEvent.from(["type": "question", "sessionId": "fleet-chat",
                                            "request": ["callId": "q", "questions": [["question": "Which release should I use?", "options": []]]]])!
            active.receive(approval)
            fleet.receive(question)
            // Attention while a different chat is foregrounded: Notifier still presents it.
            notifier.post(question, chatTitle: "Release plan", computer: "Fleet Mac", hideContent: true, computerId: "fleet")
        }
        if flags.contains("-attentionUnknown") { fleet.invalidate() }
        notifier.reconcileBadge()
        await notifier.finishBadgeWrites()
        await notifier.finishPosts()
    }

    // A resolution only invalidates; the app then re-reads chat:pending, so the fixture does too.
    func answerActive() {
        active.receive(.done(sessionId: "active-chat", messageId: nil))
        active.replace([:], ticket: active.beginSnapshot())
        notifier.reconcileBadge()
    }
    func remoteDismiss() {
        fleet.dismiss(tag: E2E.activityTag("fleet-chat"))
        fleet.replace([:], ticket: fleet.beginSnapshot())
        notifier.reconcileBadge()
    }
    func reconnectEmpty() {
        active.replace([:], ticket: active.beginSnapshot())
        fleet.replace([:], ticket: fleet.beginSnapshot())
        notifier.reconcileBadge()
    }
    func unknownPeer() { fleet.invalidate(); notifier.reconcileBadge() }
    func setEnabled(_ on: Bool) { enabled = on; notifier.reconcileBadge() }
}

struct AttentionNotificationsFixture: View {
    @State private var model = AttentionNotificationsFixtureModel()
    var body: some View {
        NavigationStack {
            List {
                Section("Whole-app attention") {
                    LabeledContent("Pending chats", value: model.count.map(String.init) ?? "Unknown")
                        .accessibilityElement(children: .combine)
                        .accessibilityValue(model.count.map(String.init) ?? "Unknown")
                        .accessibilityIdentifier("attention-count")
                    LabeledContent("Recorded badge", value: model.delivery.badges.last.map(String.init) ?? "Unchanged")
                        .accessibilityElement(children: .combine)
                        .accessibilityValue(model.delivery.badges.last.map(String.init) ?? "Unchanged")
                        .accessibilityIdentifier("attention-badge")
                    Text("Opening a chat is not answering it. An unknown computer never writes a partial badge.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section("Foreground notification") {
                    LabeledContent("Viewing", value: model.opened)
                    if let note = model.delivery.requests.last?.content {
                        VStack(alignment: .leading, spacing: 4) {
                            Label(note.title, systemImage: "bell.badge.fill").font(.headline)
                            Text(note.body)
                        }.accessibilityIdentifier("attention-banner")
                    } else { Text("No notification delivered").accessibilityIdentifier("attention-no-banner") }
                    Text("Recorded local delivery — no system notifications or real stores are used.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section("Actions") {
                    Button("Open pending chat") { model.opened = "Release plan" }
                    Button("Answer active approval") { model.answerActive() }
                    Button("Remote dismiss fleet question") { model.remoteDismiss() }
                    Button("Reconnect with no pending input") { model.reconnectEmpty() }
                    Button("Make fleet state unknown") { model.unknownPeer() }
                    Toggle("Needs-you notifications", isOn: Binding(get: { model.enabled }, set: { model.setEnabled($0) }))
                }
            }
            .navigationTitle("Attention notifications")
        }
        .task { await model.seed() }
    }
}
#endif
