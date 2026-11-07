import Foundation
import XCTest
@testable import NekkoKit
@testable import NekkoProtocol

/// Uses the existing proof-verifying computer, adding the exact service contract.
private final class ServiceComputer: RemoteConnection, ProofCaller, @unchecked Sendable {
    let proofs = ProofComputer(deviceId: "id-1")
    let lock = NSLock()
    var enabled = true
    var capabilities: [String: JSONValue] = Dictionary(uniqueKeysWithValues: ServiceAction.allCases.map { ($0.rawValue, ["supported": true]) })
    var updater: JSONValue = ServiceComputer.info("available")
    var failure: String?
    var oldHost = false
    var readRefusal: String?
    var stepUpFailures = 0
    var requireStepUp = false
    var delayed: (@Sendable () async -> Void)?
    var requests: [(String, [JSONValue], JSONValue?, JSONValue?)] = []

    static func info(_ state: String, message: String? = nil) -> JSONValue {
        ["state": .string(state), "currentVersion": "1.0.0", "version": "1.1.0", "notesUrl": "https://example.com/notes",
         "edition": "desktop", "message": message.map(JSONValue.string) ?? .null, "percent": 42.5]
    }
    func serviceCalls(_ channel: String? = nil) -> [(String, [JSONValue], JSONValue?, JSONValue?)] {
        lock.withLock { requests.filter { $0.0.hasPrefix("service:") && (channel == nil || $0.0 == channel) } }
    }
    func call(_ channel: String, _ args: [JSONValue], proof: JSONValue?, stepUp: JSONValue?, timeout: TimeInterval?) async throws -> JSONValue {
        lock.withLock { requests.append((channel, args, proof, stepUp)) }
        if channel == ChangeProof.keyChannel {
            proofs.now = Int64(Date().timeIntervalSince1970 * 1000)
            return try await proofs.call(channel, args, proof: proof, timeout: timeout)
        }
        if channel == Channels.securityChallenge {
            return ["required": true, "challenge": "dGVzdA", "expiresAt": .int(Int64(Date().timeIntervalSince1970 * 1000) + 60_000), "methods": ["totp"]]
        }
        guard channel.hasPrefix("service:") else { return .null }
        if channel == Channels.serviceStatus {
            if let readRefusal { throw RelayError("Not allowed from a paired phone (\(readRefusal)): \(channel)", fromComputer: true) }
            if oldHost { throw RelayError("Not allowed from a paired phone (channel-denied): \(channel)", fromComputer: true) }
            return ["protocolVersion": 1, "agentRunning": true, "manageServiceFromPhone": .bool(enabled), "capabilities": .object(capabilities)]
        }
        if channel == Channels.serviceUpdateState { return updater }
        // Validate the signature against the exact channel and empty args, including
        // the proof spent on a step-up refusal. A retry must have a fresh proof.
        proofs.now = Int64(Date().timeIntervalSince1970 * 1000)
        _ = try await proofs.call(channel, args, proof: proof, timeout: timeout)
        if requireStepUp, [Channels.serviceRestart, Channels.serviceUpdateInstall].contains(channel), stepUp == nil {
            throw RelayError("Not allowed from a paired phone (step-up-required): \(channel)", fromComputer: true)
        }
        if stepUp != nil, stepUpFailures > 0 {
            stepUpFailures -= 1
            throw RelayError("Not allowed from a paired phone (step-up-invalid): \(channel)", fromComputer: true)
        }
        if let delayed { await delayed() }
        if let failure { throw RelayError(failure, fromComputer: true) }
        switch channel {
        case Channels.serviceRestart: return ["restarting": true]
        case Channels.serviceUpdateInstall: return ["installing": true]
        default: return updater
        }
    }
    func call(_ channel: String, _ args: [JSONValue], proof: JSONValue?, timeout: TimeInterval?) async throws -> JSONValue {
        try await call(channel, args, proof: proof, stepUp: nil, timeout: timeout)
    }
    func call(_ channel: String, _ args: [JSONValue], timeout: TimeInterval?) async throws -> JSONValue {
        try await call(channel, args, proof: nil, stepUp: nil, timeout: timeout)
    }
    func setHandlers(onStatus: (@Sendable (RelayStatus) -> Void)?, onEvent: (@Sendable (String, JSONValue) -> Void)?,
                     onWelcome: (@Sendable (WelcomedDevice) -> Void)?) {
        proofs.setHandlers(onStatus: onStatus, onEvent: onEvent, onWelcome: onWelcome)
    }
    func online() { proofs.online() }
    func connect() {}
    func close() {}
    func nudge() {}
    func reconnect() {}
    func registerPush(token: String) async throws {}
    func registerCard(token: String?, startToken: String?, level: LiveLevel, computerId: String, computerName: String) async throws {}
}

private actor ServiceGate {
    var waiting: CheckedContinuation<Void, Never>?
    var started = false
    func wait() async { started = true; await withCheckedContinuation { waiting = $0 } }
    func release() { waiting?.resume(); waiting = nil }
}

@MainActor
final class ServiceManagementTests: XCTestCase {
    private func paired(_ computer: ServiceComputer, second: ServiceComputer? = nil) async throws -> (ComputersStore, ServiceManagementModel) {
        var ids = 0
        let store = ComputersStore(store: MemoryStore(), makeConnection: { config in
            config.room == "b1b2c3d4e5f60718" ? (second ?? computer) : computer
        }, deviceName: { "iPhone" }, deriveKey: { _, _ in Data(repeating: 7, count: 32) }, newId: {
            ids += 1
            // First computer and phone use id-1; subsequent computers are distinct.
            return ids <= 2 ? "id-1" : "id-\(ids - 1)"
        })
        store.load()
        _ = try await store.pair(PairingLink(relayUrl: "ws://studio.tail1.ts.net:4400", room: "a1b2c3d4e5f60718",
                                           key: "00112233445566778899aabbccddeeff", hostKey: testHostKey, pair: "ABCD2345"))
        store.changeSigner = SoftwareChangeSigner()
        computer.online()
        for _ in 0..<20 { await Task.yield() }
        XCTAssertEqual(store.conn, .online)
        let id = try XCTUnwrap(store.activeId)
        return (store, ServiceManagementModel(computerId: id, store: store))
    }

    func testExactPayloadReadWithoutProofAndEveryMutationSigned() async throws {
        let computer = ServiceComputer()
        let (store, model) = try await paired(computer)
        _ = store // retain the active store throughout the test
        await model.refresh()
        XCTAssertNotNil(model.status)
        XCTAssertEqual(model.update?.state, .available)
        XCTAssertFalse(model.shouldPoll)
        await model.request(.updateCheck)
        await model.request(.updateDownload)
        computer.updater = ServiceComputer.info("downloaded")
        await model.refresh()
        await model.request(.updateInstall)
        XCTAssertEqual(model.pendingConfirmation, .updateInstall)
        await model.confirm()?.value
        XCTAssertTrue(model.awaitingReconnect)
        XCTAssertTrue(model.notice?.contains("not yet verified") == true)
        XCTAssertNil(model.status)
        await model.connectionChanged() // A view/foreground refresh is not a reconnect.
        XCTAssertTrue(model.awaitingReconnect)
        let id = try XCTUnwrap(store.activeId)
        store.disconnect()
        await model.connectionChanged()
        store.connect(id)
        computer.online()
        for _ in 0..<20 { await Task.yield() }
        await model.connectionChanged()
        XCTAssertFalse(model.awaitingReconnect)
        await model.request(.restart)
        await model.confirm()?.value
        let calls = computer.serviceCalls()
        XCTAssertTrue(calls.allSatisfy { $0.1 == [] })
        for action in [ServiceAction.updateCheck, .updateDownload, .updateInstall, .restart] {
            XCTAssertEqual(computer.serviceCalls(action.channel).count, 1, action.rawValue)
            XCTAssertNotNil(computer.serviceCalls(action.channel).first?.2)
        }
        XCTAssertTrue(calls.filter { [Channels.serviceStatus, Channels.serviceUpdateState].contains($0.0) }.allSatisfy { $0.2 == nil && $0.3 == nil })
        XCTAssertTrue(Channels.serviceChange.isSubset(of: Channels.change))
        XCTAssertTrue(Set([Channels.serviceRestart, Channels.serviceUpdateInstall]).isSubset(of: StepUp.guardedChannels))
    }

    func testOptInAndCapabilitiesGateWithoutSendingChanges() async throws {
        let computer = ServiceComputer()
        computer.enabled = false
        let (_, model) = try await paired(computer)
        await model.refresh()
        XCTAssertEqual(computer.serviceCalls().map(\.0), [Channels.serviceStatus])
        XCTAssertTrue(model.optInInstructions.contains("only be changed on the computer"))
        for action in ServiceAction.allCases { await model.request(action) }
        XCTAssertEqual(computer.serviceCalls().count, 1)
        XCTAssertNil(model.pendingConfirmation)
        computer.enabled = true
        computer.capabilities["restart"] = ["supported": false, "reason": "supervisor-unavailable"]
        computer.capabilities["updateInstall"] = ["supported": false, "reason": "interactive-admin-install"]
        await model.refresh()
        XCTAssertTrue(model.disabledReason(.restart)?.contains("supervisor") == true)
        XCTAssertTrue(model.disabledReason(.updateInstall)?.contains("local approval") == true)
        await model.request(.restart)
        await model.request(.updateInstall)
        XCTAssertNil(model.pendingConfirmation)
        XCTAssertTrue(computer.serviceCalls(Channels.serviceRestart).isEmpty)
        XCTAssertTrue(computer.serviceCalls(Channels.serviceUpdateInstall).isEmpty)
    }

    func testConfirmationsCancelAndInstallReadiness() async throws {
        let computer = ServiceComputer()
        let (_, model) = try await paired(computer)
        await model.refresh()
        await model.request(.updateInstall)
        XCTAssertNil(model.pendingConfirmation)
        XCTAssertTrue(model.disabledReason(.updateInstall)?.contains("Download") == true)
        await model.request(.restart)
        XCTAssertEqual(model.pendingConfirmation, .restart)
        XCTAssertTrue(computer.serviceCalls(Channels.serviceRestart).isEmpty)
        model.cancelConfirmation()
        XCTAssertNil(model.confirm())
        XCTAssertTrue(computer.serviceCalls(Channels.serviceRestart).isEmpty)
        XCTAssertTrue(ServiceAction.restart.confirmation.contains("not the computer"))
        XCTAssertTrue(ServiceAction.updateInstall.confirmation.contains("check the version"))
    }

    func testBusyAndTimeoutAreNotReplayedByRefreshOrReconnect() async throws {
        let computer = ServiceComputer()
        let (_, model) = try await paired(computer)
        await model.refresh()
        let gate = ServiceGate()
        computer.delayed = { await gate.wait() }
        computer.failure = "Request timed out"
        let first = Task { await model.request(.updateCheck) }
        for _ in 0..<200 { if await gate.started { break }; await Task.yield() }
        XCTAssertEqual(model.inFlight, .updateCheck)
        await model.request(.updateCheck)
        await model.request(.restart)
        XCTAssertNil(model.pendingConfirmation)
        XCTAssertEqual(computer.serviceCalls(Channels.serviceUpdateCheck).count, 1)
        await gate.release()
        await first.value
        XCTAssertNil(model.inFlight)
        XCTAssertTrue(model.problem?.contains("outcome may be unknown") == true)
        XCTAssertFalse(model.shouldPoll)
        await model.refresh()
        await model.connectionChanged()
        XCTAssertEqual(computer.serviceCalls(Channels.serviceUpdateCheck).count, 1)
        XCTAssertTrue(computer.serviceCalls(Channels.serviceRestart).isEmpty)
    }

    func testStepUpUsesNativePromptFreshProofAndExactEmptyArgs() async throws {
        let computer = ServiceComputer()
        computer.requireStepUp = true
        let (store, model) = try await paired(computer)
        var asked: [StepUpRequest] = []
        store.stepUpPrompt = { request in asked.append(request); return .totp("123456") }
        await model.refresh()
        await model.request(.restart)
        await model.confirm()?.value
        XCTAssertNil(model.problem)
        XCTAssertEqual(asked.count, 1)
        XCTAssertEqual(asked.first?.action, "Restart Nekko Agent on My computer")
        let calls = computer.serviceCalls(Channels.serviceRestart)
        XCTAssertEqual(calls.count, 2)
        XCTAssertNil(calls.first?.3)
        XCTAssertEqual(calls.last?.3, ["totp": "123456"])
        XCTAssertNotEqual(calls.first?.2, calls.last?.2)
        XCTAssertTrue(calls.allSatisfy { $0.1 == [] && $0.2 != nil })
        XCTAssertTrue(model.awaitingReconnect)
    }

    func testStepUpFailureIsBoundedAndEachAttemptHasFreshProof() async throws {
        let computer = ServiceComputer()
        computer.requireStepUp = true
        computer.stepUpFailures = 10
        let (store, model) = try await paired(computer)
        var asked: [StepUpRequest] = []
        store.stepUpPrompt = { request in asked.append(request); return .totp("123456") }
        await model.refresh()
        await model.request(.restart)
        await model.confirm()?.value
        XCTAssertEqual(asked.map(\.attempt), [1, 2, 3])
        XCTAssertNotNil(asked.last?.problem)
        XCTAssertNotNil(model.problem)
        XCTAssertNil(model.inFlight)
        XCTAssertFalse(model.awaitingReconnect)
        let calls = computer.serviceCalls(Channels.serviceRestart)
        XCTAssertEqual(calls.count, 1 + StepUp.maxAttempts)
        XCTAssertEqual(Set(calls.compactMap { $0.2?.serialized() }).count, calls.count)
        await model.refresh()
        XCTAssertEqual(computer.serviceCalls(Channels.serviceRestart).count, calls.count)
    }

    func testStepUpCancelSendsNoFurtherMutation() async throws {
        let computer = ServiceComputer()
        computer.requireStepUp = true
        let (store, model) = try await paired(computer)
        store.stepUpPrompt = { _ in nil }
        await model.refresh()
        await model.request(.restart)
        await model.confirm()?.value
        XCTAssertTrue(model.problem?.contains("Not confirmed") == true)
        XCTAssertEqual(computer.serviceCalls(Channels.serviceRestart).count, 1)
        XCTAssertFalse(model.awaitingReconnect)
        XCTAssertNil(model.inFlight)
    }

    func testSwitchingComputersDuringStepUpNeverRedirectsMutation() async throws {
        let computer = ServiceComputer()
        computer.requireStepUp = true
        let other = ServiceComputer()
        let (store, model) = try await paired(computer, second: other)
        store.stepUpPrompt = { _ in
            do {
                _ = try await store.pair(PairingLink(relayUrl: "ws://other.tail1.ts.net:4400", room: "b1b2c3d4e5f60718",
                                                   key: "00112233445566778899aabbccddeeff", hostKey: otherTestHostKey, pair: "ABCD2345"))
                other.online()
                for _ in 0..<20 { await Task.yield() }
            } catch { XCTFail("Could not pair the second fake computer: \(error)") }
            return .totp("123456")
        }
        await model.refresh()
        await model.request(.restart)
        await model.confirm()?.value
        XCTAssertEqual(computer.serviceCalls(Channels.serviceRestart).count, 1)
        XCTAssertFalse(model.online)
        XCTAssertEqual(store.conn, .online)
        XCTAssertNotEqual(store.activeId, model.computerId)
        XCTAssertNil(model.inFlight)
        XCTAssertNil(model.notice)
        await model.request(.updateCheck)
        XCTAssertTrue(computer.serviceCalls(Channels.serviceUpdateCheck).isEmpty)
        XCTAssertTrue(other.serviceCalls().isEmpty, "No service read, mutation or step-up reply may follow the new active computer.")
    }

    func testOldHostUnsupportedAndReadOffAreReadableNoFallback() async throws {
        let computer = ServiceComputer()
        computer.oldHost = true
        let (_, model) = try await paired(computer)
        await model.refresh()
        XCTAssertTrue(model.unsupported)
        XCTAssertTrue(model.problem?.contains("Update Nekko Agent") == true)
        XCTAssertNil(model.status)
        for action in ServiceAction.allCases { await model.request(action) }
        XCTAssertEqual(computer.serviceCalls().map(\.0), [Channels.serviceStatus])
        XCTAssertFalse(computer.requests.contains { $0.0.hasPrefix("update:") || $0.0.hasPrefix("shell:") || $0.0 == Channels.appQuit })
        let error = PhoneRefusal("Not allowed from a paired phone (service-disabled): service:updateCheck")
        XCTAssertTrue(error?.message(computer: "Studio")?.contains("Manage service from phone") == true)
    }

    func testReadAndChangeRefusalsRemainReadable() async throws {
        let computer = ServiceComputer()
        let (_, model) = try await paired(computer)
        computer.readRefusal = "read-off"
        await model.refresh()
        XCTAssertTrue(model.problem?.contains("Reading from this phone is turned off") == true)
        XCTAssertNil(model.status)
        XCTAssertFalse(model.unsupported)
        computer.readRefusal = nil
        await model.refresh()
        computer.proofs.changeOn = false
        await model.request(.updateCheck)
        XCTAssertTrue(model.problem?.contains("Changes from this phone are turned off") == true)
        XCTAssertNil(model.inFlight)
        XCTAssertFalse(model.shouldPoll)
        XCTAssertEqual(computer.serviceCalls(Channels.serviceUpdateCheck).count, 1)
        computer.proofs.changeOn = true
        computer.failure = "Not allowed from a paired phone (service-disabled): service:updateCheck"
        await model.request(.updateCheck)
        XCTAssertTrue(model.problem?.contains("Manage service from phone") == true)
        XCTAssertNil(model.inFlight)
    }

    func testPollingOnlyBusyUpdaterAndCapabilitiesRediscoveredAfterActions() async throws {
        let computer = ServiceComputer()
        let (_, model) = try await paired(computer)
        await model.refresh()
        let initial = computer.serviceCalls(Channels.serviceStatus).count
        computer.updater = ServiceComputer.info("downloading")
        await model.request(.updateDownload)
        XCTAssertTrue(model.shouldPoll)
        XCTAssertEqual(computer.serviceCalls(Channels.serviceStatus).count, initial + 1)
        await model.pollUpdate()
        XCTAssertTrue(model.shouldPoll)
        computer.updater = ServiceComputer.info("downloaded")
        computer.capabilities["updateInstall"] = ["supported": false, "reason": "interactive-admin-install"]
        await model.pollUpdate()
        XCTAssertFalse(model.shouldPoll)
        XCTAssertEqual(model.update?.state, .downloaded)
        XCTAssertTrue(model.disabledReason(.updateInstall)?.contains("local approval") == true)
        let stopped = computer.serviceCalls().count
        await model.pollUpdate()
        XCTAssertEqual(computer.serviceCalls().count, stopped)
    }

    func testUpdaterFailureClearsInFlightAndShowsMessage() async throws {
        let computer = ServiceComputer()
        let (_, model) = try await paired(computer)
        await model.refresh()
        computer.updater = ServiceComputer.info("error", message: "Signature verification failed")
        await model.request(.updateCheck)
        XCTAssertEqual(model.update?.state, .error)
        XCTAssertEqual(model.problem, "Signature verification failed")
        XCTAssertNil(model.inFlight)
        XCTAssertFalse(model.shouldPoll)
    }

    func testWrongComputerAndOfflineDoNotReadOrMutate() async throws {
        let computer = ServiceComputer()
        let (store, model) = try await paired(computer)
        let wrong = ServiceManagementModel(computerId: "not-active", store: store)
        await wrong.refresh()
        await wrong.request(.restart)
        XCTAssertNil(wrong.knownVersion)
        XCTAssertTrue(computer.serviceCalls().isEmpty)
        store.disconnect()
        await model.connectionChanged()
        await model.refresh()
        await model.request(.updateCheck)
        XCTAssertTrue(computer.serviceCalls().isEmpty)
    }

    func testMalformedStatusFailsClosedAndUpdateProjection() throws {
        XCTAssertNil(ServiceStatus.from(["protocolVersion": 1, "agentRunning": true, "manageServiceFromPhone": true, "capabilities": [:]]))
        XCTAssertNil(ServiceStatus.from(["protocolVersion": 2, "agentRunning": true]))
        var raw = ServiceComputer.info("downloading").object!
        raw["percent"] = 999
        XCTAssertEqual(ServiceUpdate.from(.object(raw))?.percent, 100)
        raw["state"] = "unexpected"
        XCTAssertNil(ServiceUpdate.from(.object(raw)))
        for reason in ["supervisor-unavailable", "native-updater-unavailable", "app-not-packaged", "update-feed-unavailable",
                       "packaged-install-required", "interactive-package-install", "interactive-admin-install", "install-layout-unsupported", "install-already-requested"] {
            XCTAssertFalse(ServiceManagementModel.capabilityReason(reason).contains(reason))
        }
    }
}
