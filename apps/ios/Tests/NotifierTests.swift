import NekkoProtocol
import UserNotifications
import XCTest
@testable import NekkoNative

@MainActor
final class NotifierTests: XCTestCase {
    final class Delivery: NotificationDelivery {
        var status = NotificationPermission(allowed: true, badges: true, sound: true)
        var requests: [UNNotificationRequest] = []
        var badges: [Int] = []
        var holdBadge = false
        var gate: CheckedContinuation<Void, Never>?
        var inFlight = 0
        var maximumInFlight = 0
        func permission() async -> NotificationPermission { status }
        func add(_ request: UNNotificationRequest) async throws { requests.append(request) }
        func setBadge(_ count: Int) async throws {
            inFlight += 1
            maximumInFlight = max(maximumInFlight, inFlight)
            badges.append(count)
            if holdBadge { await withCheckedContinuation { gate = $0 } }
            inFlight -= 1
        }
    }

    func testForegroundAttentionPresentsEvenWithoutAnOpenedChatTracker() {
        let notifier = Notifier(delivery: Delivery())
        XCTAssertTrue(notifier.presentation(.init(["kind": "needs-you"]), remote: false).contains(.banner))
        XCTAssertEqual(notifier.presentation(.init(["kind": "finished"]), remote: false), [])
        notifier.wants = { $0 != .needsYou }
        XCTAssertEqual(notifier.presentation(.init(["kind": "needs-you"]), remote: false), [])
        XCTAssertTrue(notifier.presentation(.init(["kind": "test"]), remote: false).contains(.banner))
        XCTAssertTrue(notifier.presentation(.init(["unsent": true]), remote: false).contains(.banner))
    }

    func testBadgesAreSerialAndClearAnAuthoritativeZero() async {
        let delivery = Delivery()
        let notifier = Notifier(delivery: delivery)
        var count: Int? = 2
        notifier.badgeCount = { count }
        delivery.holdBadge = true
        notifier.reconcileBadge()
        for _ in 0..<100 where delivery.gate == nil { await Task.yield() }
        XCTAssertNotNil(delivery.gate)
        count = 0
        notifier.reconcileBadge()
        XCTAssertEqual(delivery.badges, [2])
        delivery.holdBadge = false
        delivery.gate?.resume()
        delivery.gate = nil
        await notifier.finishBadgeWrites()
        XCTAssertEqual(delivery.badges, [2, 0])
        XCTAssertEqual(delivery.maximumInFlight, 1)
        count = nil
        notifier.reconcileBadge()
        await notifier.finishBadgeWrites()
        XCTAssertEqual(delivery.badges, [2, 0], "unknown never writes a partial count or a fabricated zero")
    }

    func testAPNsArrivalWithdrawsLocalAuthorityBeforeQueuedWrites() async {
        let delivery = Delivery()
        let notifier = Notifier(delivery: delivery)
        var count: Int? = 3
        notifier.badgeCount = { count }
        notifier.onRemote = { _ in count = nil }
        notifier.reconcileBadge()
        _ = notifier.presentation(.init(["kind": "needs-you", "tag": E2E.activityTag("s")]), remote: true)
        await notifier.finishBadgeWrites()
        XCTAssertTrue(delivery.badges.isEmpty)
    }

    func testPermissionsPrefsAndPrivacyApplyToLocalDeliveryWithoutCapturedBadges() async throws {
        let delivery = Delivery()
        let notifier = Notifier(delivery: delivery)
        let event = try XCTUnwrap(AgentEvent.from(["type": "question", "sessionId": "s",
                                                  "request": ["callId": "q", "questions": [["question": "Private question", "options": []]]]]))
        notifier.post(event, chatTitle: "Private chat", computer: "Work Mac", hideContent: true, computerId: "fleet")
        await notifier.finishPosts()
        let note = try XCTUnwrap(delivery.requests.last?.content)
        XCTAssertEqual(note.title, "Work Mac")
        XCTAssertEqual(note.body, "Your computer has a question.")
        XCTAssertEqual(note.userInfo["computerId"] as? String, "fleet")
        XCTAssertNil(note.badge, "only the serialized badge writer owns a local badge")
        delivery.status = .init(allowed: false, badges: false, sound: false)
        notifier.post(.done(sessionId: "denied", messageId: nil), chatTitle: "Denied", computer: "Mac", hideContent: false)
        notifier.badgeCount = { 7 }
        notifier.reconcileBadge()
        await notifier.finishPosts()
        await notifier.finishBadgeWrites()
        XCTAssertEqual(delivery.requests.count, 1)
        XCTAssertTrue(delivery.badges.isEmpty)
        delivery.status = .init(allowed: true, badges: false, sound: false)
        notifier.wants = { $0 != .needsYou }
        notifier.post(event, chatTitle: "No", computer: "Mac", hideContent: false, computerId: "other")
        await notifier.finishPosts()
        XCTAssertEqual(delivery.requests.count, 1)
        notifier.post(.done(sessionId: "quiet", messageId: nil), chatTitle: "Quiet", computer: "Mac", hideContent: false)
        await notifier.finishPosts()
        XCTAssertNil(delivery.requests.last?.content.sound)
    }

    func testFixtureUsesOnlyRecorderAndOpeningDoesNotResolvePending() async {
        let model = AttentionNotificationsFixtureModel()
        await model.seed()
        XCTAssertEqual(model.count, 2)
        XCTAssertEqual(model.delivery.badges.last, 2)
        model.opened = "Release plan"
        XCTAssertEqual(model.count, 2)
        model.answerActive()
        model.remoteDismiss()
        await model.notifier.finishBadgeWrites()
        XCTAssertEqual(model.delivery.badges.last, 0)
        model.unknownPeer()
        await model.notifier.finishBadgeWrites()
        XCTAssertNil(model.count)
        XCTAssertEqual(model.delivery.badges.last, 0)
    }
}
