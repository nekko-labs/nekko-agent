import Foundation
import XCTest
@testable import NekkoKit
@testable import NekkoProtocol

/// Nekko Cloud machines from the phone (decision 0017): list, make and pair,
/// scope, stop and delete, against an in-memory Nekko Cloud.
@MainActor
final class CloudMachinesTests: XCTestCase {
    final class MemorySecrets: SecureStore, @unchecked Sendable {
        var items: [String: String] = [:]
        func get(_ key: String) -> String? { items[key] }
        func set(_ key: String, _ value: String?) { items[key] = value }
    }

    final class FakeMachines: CloudHTTP, @unchecked Sendable {
        var machines: [JSONValue] = []
        var calls: [(String, String, JSONValue)] = []
        let lock = NSLock()

        func send(_ method: String, _ url: URL, headers: [String: String], body: Data?) async throws -> (Int, Data) {
            lock.lock(); defer { lock.unlock() }
            let b = body.flatMap { try? JSONValue.parse($0) } ?? .null
            calls.append((method, url.path, b))
            guard headers["Authorization"] == "Bearer nk_test" else { return (401, Data("{\"error\":\"unauthenticated\"}".utf8)) }
            let answer: (Int, JSONValue)
            switch (method, url.path) {
            case ("GET", "/v1/machines"):
                answer = (200, .object(["machines": .array(machines), "relayUrl": .string("wss://relay.test"), "hoursIncluded": .int(40)]))
            case ("POST", "/v1/machines"):
                let m: JSONValue = .object(["id": .string("m-1"), "name": b["name"] ?? .string("Nekko Cloud"), "region": b["region"] ?? .string("nrt"),
                                            "state": .string("running"), "room": .string("abcdef0123456789abcd"), "scope": b["scope"] ?? .object([:]),
                                            "hoursUsed": .double(0), "hoursIncluded": .int(40)])
                machines.append(m)
                answer = (201, .object(["machine": m, "pairingLink": .string("nekko-agent-pair:?relay=wss%3A%2F%2Frelay.test&room=abcdef0123456789abcd&key=0123456789abcdef0123456789abcdef&pair=ABCD2345"), "pairingCode": .string("ABCD2345")]))
            case ("PUT", "/v1/machines/m-1/scope"):
                var m = machines[0].object ?? [:]
                m["scope"] = b
                machines[0] = .object(m)
                answer = (200, .object(["machine": machines[0], "appliesOn": .string("next start")]))
            case ("POST", "/v1/machines/m-1/stop"):
                var m = machines[0].object ?? [:]
                m["state"] = .string("stopped")
                machines[0] = .object(m)
                answer = (200, .object(["machine": machines[0]]))
            case ("DELETE", "/v1/machines/m-1"):
                machines.removeAll()
                answer = (204, .null)
            default:
                answer = (404, .object(["error": .string("not-found")]))
            }
            return (answer.0, Data(answer.1.serialized().utf8))
        }
    }

    private func client(_ http: FakeMachines, _ secrets: MemorySecrets) -> CloudSync {
        secrets.set("cloud.token", "nk_test")
        return CloudSync(api: URL(string: "https://api.test")!, http: http, secrets: secrets, files: nil, deviceLabel: "iPhone",
                         key: { SyncCrypto.SoftwareKey() })
    }

    func testMakesPairsScopesStopsAndDeletesAMachine() async throws {
        let http = FakeMachines()
        let secrets = MemorySecrets()
        let cloud = client(http, secrets)
        try await cloud.loadMachines()
        XCTAssertEqual(cloud.machines.count, 0)
        XCTAssertEqual(cloud.machinesRelay, "wss://relay.test")

        let made = try await cloud.createMachine(name: "Tokyo box", region: "nrt", scope: CloudSync.MachineScope(repos: ["nekko-labs/nekko-agent"]))
        XCTAssertEqual(made.machine.id, "m-1")
        XCTAssertEqual(made.machine.scope.repos, ["nekko-labs/nekko-agent"])
        XCTAssertTrue(made.machine.scope.privacyShield)
        XCTAssertEqual(made.link.room, "abcdef0123456789abcd")
        XCTAssertEqual(made.link.pair, "ABCD2345")
        XCTAssertEqual(made.link.relayUrl, "wss://relay.test")
        let sent = http.calls.first { $0.0 == "POST" && $0.1 == "/v1/machines" }?.2
        XCTAssertEqual(sent?["scope"]?["privacyShield"]?.bool, true)
        XCTAssertEqual(sent?["scope"]?["memory"]?.bool, false)

        // The pairing is recorded beside the token, and found again from the computer's id.
        cloud.link(made.machine, computer: "computer-9")
        XCTAssertEqual(cloud.machine(forComputer: "computer-9")?.id, "m-1")
        XCTAssertEqual(cloud.computerId(for: made.machine), "computer-9")
        let again = client(http, secrets)
        try await again.loadMachines()
        XCTAssertEqual(again.machine(forComputer: "computer-9")?.name, "Tokyo box")

        try await cloud.setScope(made.machine, CloudSync.MachineScope(repos: [], privacyShield: false, memory: true, syncBack: true))
        XCTAssertEqual(cloud.machines[0].scope.privacyShield, false)
        XCTAssertEqual(cloud.machines[0].scope.memory, true)
        try await cloud.stopMachine(made.machine)
        XCTAssertEqual(cloud.machines[0].state, "stopped")
        try await cloud.deleteMachine(made.machine)
        XCTAssertTrue(cloud.machines.isEmpty)
        XCTAssertNil(cloud.machine(forComputer: "computer-9"))
        XCTAssertNil(secrets.get("cloud.machines").flatMap { try? JSONValue.parse($0) }?["m-1"])
    }

    func testSignedOutPhonesCannotReachMachines() async {
        let http = FakeMachines()
        let secrets = MemorySecrets()
        let cloud = CloudSync(api: URL(string: "https://api.test")!, http: http, secrets: secrets, files: nil, deviceLabel: "iPhone", key: { SyncCrypto.SoftwareKey() })
        do {
            try await cloud.loadMachines()
            XCTFail("needs a token")
        } catch let e as CloudError {
            XCTAssertEqual(e.message, "Sign in to Nekko Cloud first.")
        } catch { XCTFail("\(error)") }
    }
}
