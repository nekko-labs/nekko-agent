import Foundation
import XCTest
@testable import NekkoKit
@testable import NekkoProtocol

@MainActor
final class CloudFleetTests: XCTestCase {
    typealias HTTP = CloudMachinesTests.FakeMachines
    typealias Secrets = CloudMachinesTests.MemorySecrets

    private let machine: JSONValue = .object([
        "id": .string("m-1"), "name": .string("Cloud box"), "state": .string("running")
    ])

    private func client(_ http: any CloudHTTP, _ secrets: Secrets, signedIn: Bool = true) -> CloudSync {
        if signedIn {
            secrets.set("cloud.token", "nk_test")
            let state = CloudSync.State(account: .init(id: "account-1", email: "test@example.test", plan: "pro", canSync: true), keysAccount: "account-1")
            secrets.set("cloud.state", String(decoding: try! JSONEncoder().encode(state), as: UTF8.self))
        }
        return CloudSync(api: URL(string: "https://api.test")!, http: http, secrets: secrets, files: nil,
                         deviceLabel: "iPhone", key: { SyncCrypto.SoftwareKey() })
    }

    func testGateRequiresEnabledSignedInAndConnected() {
        let m = CloudSync.Machine.from(machine)!
        for enabled in [false, true] {
            for signedIn in [false, true] {
                for connected in [false, true] {
                    let fleet = CloudFleet(enabled: enabled, signedIn: signedIn, connected: connected,
                                           machines: [m], machineLinks: ["m-1": "paired"], pairedComputerIds: ["paired"])
                    XCTAssertEqual(fleet.visible, enabled && signedIn && connected)
                    XCTAssertEqual(fleet.rows.count, fleet.visible ? 1 : 0)
                    XCTAssertEqual(fleet.excludedComputerIds, fleet.visible ? ["paired"] : [])
                }
            }
        }
    }

    func testDefaultOffDoesNotFetchAndLeavesSyncSignedIn() async throws {
        let http = HTTP()
        let cloud = client(http, Secrets())
        XCTAssertFalse(cloud.fleetEnabled)
        XCTAssertTrue(cloud.signedIn)
        XCTAssertEqual(cloud.phase, .notSetUp)
        try await cloud.loadMachines()
        XCTAssertTrue(http.calls.isEmpty)
        XCTAssertFalse(cloud.fleetConnected)
        // Provisioning cannot bypass the feature flag either.
        do {
            _ = try await cloud.createMachine(name: "No", region: "nrt", scope: .init())
            XCTFail("disabled fleet cannot provision")
        } catch {}
        XCTAssertTrue(http.calls.isEmpty)
    }

    func testEnabledSignedOutDoesNotFetch() async {
        let http = HTTP()
        let cloud = client(http, Secrets(), signedIn: false)
        cloud.fleetEnabled = true
        do { try await cloud.loadMachines(); XCTFail("sign-in required") } catch {}
        XCTAssertFalse(cloud.fleetConnected)
        XCTAssertTrue(http.calls.isEmpty)
    }

    func testStoredCredentialsAreNotAConnectionAndFetchConnects() async throws {
        let http = HTTP()
        http.machines = [machine]
        let cloud = client(http, Secrets())
        cloud.fleetEnabled = true
        XCTAssertFalse(cloud.fleetConnected)
        XCTAssertFalse(cloud.fleet(pairedComputerIds: []).visible)
        try await cloud.loadMachines()
        XCTAssertTrue(cloud.fleetConnected)
        XCTAssertEqual(http.calls.map { $0.1 }, ["/v1/auth/me", "/v1/machines"])
        XCTAssertTrue(cloud.fleet(pairedComputerIds: []).visible)
        XCTAssertNotNil(cloud.fleet(pairedComputerIds: []).rows[0].explanation)
        cloud.fleetEnabled = false
        XCTAssertFalse(cloud.fleetConnected)
        XCTAssertTrue(cloud.machines.isEmpty)
        cloud.fleetEnabled = true
        XCTAssertFalse(cloud.fleetConnected)
    }

    func testFailedRefreshDisconnectsAndClearsRowsAndLinks() async throws {
        let http = HTTP()
        http.machines = [machine]
        let cloud = client(http, Secrets())
        cloud.fleetEnabled = true
        try await cloud.loadMachines()
        cloud.link(cloud.machines[0], computer: "paired")
        XCTAssertEqual(cloud.fleetExcludedComputerIds(pairedComputerIds: ["paired"]), ["paired"])
        http.fleetStatus = 503
        do { try await cloud.loadMachines(); XCTFail("fetch should fail") } catch {}
        XCTAssertFalse(cloud.fleetConnected)
        XCTAssertTrue(cloud.machines.isEmpty)
        XCTAssertTrue(cloud.machineLinks.isEmpty)
        XCTAssertTrue(cloud.fleetExcludedComputerIds(pairedComputerIds: ["paired"]).isEmpty)
    }

    func testMalformedSuccessfulResponseDoesNotConnect() async {
        let http = HTTP()
        http.malformedFleet = true
        let cloud = client(http, Secrets())
        cloud.fleetEnabled = true
        do { try await cloud.loadMachines(); XCTFail("fleet list required") } catch {}
        XCTAssertFalse(cloud.fleetConnected)
        XCTAssertTrue(cloud.machines.isEmpty)
    }

    func testStaleAccountCannotOpenGateOrRequestFleet() async {
        let http = HTTP()
        http.accountId = "another-account"
        let cloud = client(http, Secrets())
        cloud.fleetEnabled = true
        do { try await cloud.loadMachines(); XCTFail("stale account") } catch {}
        XCTAssertFalse(cloud.fleetConnected)
        XCTAssertEqual(http.calls.map { $0.1 }, ["/v1/auth/me"])
    }

    func testLinksAreAccountScopedAndRequireRealPairings() async throws {
        let http = HTTP()
        http.machines = [machine]
        let secrets = Secrets()
        secrets.set("cloud.machines", "{\"m-1\":\"other-account-pair\"}")
        secrets.set("cloud.machines.account", "another-account")
        let cloud = client(http, secrets)
        cloud.fleetEnabled = true
        try await cloud.loadMachines()
        XCTAssertTrue(cloud.machineLinks.isEmpty)
        cloud.link(cloud.machines[0], computer: "paired")
        XCTAssertEqual(secrets.get("cloud.machines.account"), "account-1")
        XCTAssertTrue(cloud.fleet(pairedComputerIds: ["same-name-not-linked"]).excludedComputerIds.isEmpty)
        let fleet = cloud.fleet(pairedComputerIds: ["paired", "same-name-not-linked"])
        XCTAssertEqual(fleet.rows[0].computerId, "paired")
        XCTAssertNil(fleet.rows[0].explanation)
        XCTAssertEqual(fleet.excludedComputerIds, ["paired"])
        await cloud.signOut()
        XCTAssertFalse(cloud.fleetConnected)
        XCTAssertTrue(cloud.machines.isEmpty)
        XCTAssertTrue(cloud.machineLinks.isEmpty)
    }

    func testLegacyUnownedLinksAreNotTrusted() async throws {
        let http = HTTP()
        http.machines = [machine]
        let secrets = Secrets()
        secrets.set("cloud.machines", "{\"m-1\":\"paired\"}")
        let cloud = client(http, secrets)
        cloud.fleetEnabled = true
        try await cloud.loadMachines()
        XCTAssertTrue(cloud.machineLinks.isEmpty)
    }

    func testUnknownMachineStateExplainsRatherThanOfferingProvisioning() {
        var value = machine.object!
        value["state"] = .string("unsupported")
        let fleet = CloudFleet(enabled: true, signedIn: true, connected: true,
                               machines: [CloudSync.Machine.from(.object(value))!], machineLinks: ["m-1": "paired"], pairedComputerIds: ["paired"])
        XCTAssertNotNil(fleet.rows[0].explanation)
    }

    func testChangedTokenImmediatelyClosesGate() async throws {
        let http = HTTP()
        let secrets = Secrets()
        let cloud = client(http, secrets)
        cloud.fleetEnabled = true
        try await cloud.loadMachines()
        secrets.set("cloud.token", "another-token")
        XCTAssertFalse(cloud.fleetConnected)
        XCTAssertFalse(cloud.fleet(pairedComputerIds: []).visible)
    }

    actor DelayedHTTP: CloudHTTP {
        private var continuation: CheckedContinuation<Void, Never>?
        private(set) var waiting = false
        func send(_ method: String, _ url: URL, headers: [String: String], body: Data?) async throws -> (Int, Data) {
            if method == "DELETE" { return (204, Data()) }
            if url.path == "/v1/auth/me" {
                return (200, Data("{\"account\":{\"id\":\"account-1\"}}".utf8))
            }
            waiting = true
            await withCheckedContinuation { continuation = $0 }
            return (200, Data("{\"machines\":[{\"id\":\"late\",\"state\":\"running\"}]}".utf8))
        }
        func resume() { continuation?.resume(); continuation = nil }
    }

    func testLateFetchCannotReopenGateAfterSignOut() async throws {
        let http = DelayedHTTP()
        let cloud = client(http, Secrets())
        cloud.fleetEnabled = true
        let fetch = Task { try await cloud.loadMachines() }
        while !(await http.waiting) { await Task.yield() }
        await cloud.signOut()
        await http.resume()
        try await fetch.value
        XCTAssertFalse(cloud.signedIn)
        XCTAssertFalse(cloud.fleetConnected)
        XCTAssertTrue(cloud.machines.isEmpty)
    }

    func testLateFetchCannotReopenGateAfterDisable() async throws {
        let http = DelayedHTTP()
        let cloud = client(http, Secrets())
        cloud.fleetEnabled = true
        let fetch = Task { try await cloud.loadMachines() }
        while !(await http.waiting) { await Task.yield() }
        cloud.fleetEnabled = false
        cloud.fleetEnabled = true
        await http.resume()
        try await fetch.value
        XCTAssertFalse(cloud.fleetConnected)
        XCTAssertTrue(cloud.machines.isEmpty)
    }
}
