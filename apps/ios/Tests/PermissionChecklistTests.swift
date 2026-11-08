import AVFoundation
@testable import NekkoNative
import XCTest

@MainActor
final class PermissionChecklistTests: XCTestCase {
    func testCaptureAuthorizationDoesNotTreatDenialAsSuccess() {
        XCTAssertEqual(PermissionChecklist.capture(.authorized), .allowed)
        XCTAssertEqual(PermissionChecklist.capture(.notDetermined), .unknown)
        XCTAssertEqual(PermissionChecklist.capture(.denied), .denied)
        XCTAssertEqual(PermissionChecklist.capture(.restricted), .restricted)
    }

    func testOnlyActualAuthorizationGetsACheckmark() {
        let unchecked: [PermissionChecklist.Access] = [.unknown, .denied, .restricted, .unavailable, .available]
        for state in unchecked {
            XCTAssertFalse(state.checked)
        }
        XCTAssertTrue(PermissionChecklist.Access.allowed.checked)
        XCTAssertTrue(PermissionChecklist.Access.quiet.checked)
        XCTAssertFalse(PermissionChecklist.Access.restricted.canRequest)
        XCTAssertFalse(PermissionChecklist.Access.unavailable.canRequest)
    }

    func testCancelledRequestsNeverStartDiscovery() async {
        let checklist = PermissionChecklist()
        let task = Task { await checklist.request(.network) }
        task.cancel()
        await task.value
        XCTAssertNil(checklist.busy)
        XCTAssertEqual(checklist.status(.network), .unknown)
        XCTAssertEqual(checklist.nearby.state, .idle)
    }

    func testFullInventoryIsUniqueAndExplained() {
        let items = PermissionChecklist.Item.allCases
        XCTAssertEqual(items.count, 8)
        XCTAssertEqual(Set(items.map(\.id)).count, items.count)
        for item in items {
            XCTAssertFalse(item.title.isEmpty)
            XCTAssertFalse(item.detail.isEmpty)
            XCTAssertFalse(item.icon.isEmpty)
        }
        let checklist = PermissionChecklist()
        XCTAssertEqual(checklist.status(.network), .unknown)
        XCTAssertNil(checklist.busy)
    }
}
