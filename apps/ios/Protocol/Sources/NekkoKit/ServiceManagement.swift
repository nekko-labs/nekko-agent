import Foundation
import NekkoProtocol
import Observation

/// The version-1 service contract (#2053). Capabilities describe support, not permission.
public struct ServiceStatus: Equatable, Sendable {
    public struct Capability: Equatable, Sendable {
        public let supported: Bool
        public let reason: String?
    }

    public let manageServiceFromPhone: Bool
    public let capabilities: [ServiceAction: Capability]

    public static func from(_ value: JSONValue) -> ServiceStatus? {
        guard value.long("protocolVersion") == 1, value["agentRunning"] == .bool(true),
              let enabled = value["manageServiceFromPhone"]?.bool,
              let caps = value["capabilities"]?.object else { return nil }
        var parsed: [ServiceAction: Capability] = [:]
        for action in ServiceAction.allCases {
            guard let entry = caps[action.rawValue], let supported = entry["supported"]?.bool else { return nil }
            parsed[action] = Capability(supported: supported, reason: entry.str("reason"))
        }
        return ServiceStatus(manageServiceFromPhone: enabled, capabilities: parsed)
    }
}

public enum ServiceAction: String, CaseIterable, Identifiable, Sendable {
    case restart, updateState, updateCheck, updateDownload, updateInstall
    public var id: String { rawValue }
    public var channel: String {
        switch self {
        case .restart: return Channels.serviceRestart
        case .updateState: return Channels.serviceUpdateState
        case .updateCheck: return Channels.serviceUpdateCheck
        case .updateDownload: return Channels.serviceUpdateDownload
        case .updateInstall: return Channels.serviceUpdateInstall
        }
    }
    public var title: String {
        switch self {
        case .restart: return "Restart Nekko Agent"
        case .updateState: return "Refresh update status"
        case .updateCheck: return "Check for updates"
        case .updateDownload: return "Download update"
        case .updateInstall: return "Install update"
        }
    }
    public var needsConfirmation: Bool { self == .restart || self == .updateInstall }
    public var confirmation: String {
        self == .restart
            ? "Restart Nekko Agent, not the computer. Active chats may be interrupted and this phone will disconnect. Reconnect to check that the service is running."
            : "Install the downloaded update and restart Nekko Agent. Active chats may be interrupted and this phone will disconnect. Reconnect and check the version to verify installation."
    }
}

/// A narrow projection of the existing UpdateInfo. Unknown states fail closed.
public struct ServiceUpdate: Equatable, Sendable {
    public enum State: String, Sendable {
        case idle, checking, available, downloading, downloaded, none, error
    }
    public let state: State
    public let currentVersion: String
    public let version: String?
    public let percent: Double?
    public let message: String?

    public var busy: Bool { state == .checking || state == .downloading }
    public static func from(_ value: JSONValue) -> ServiceUpdate? {
        guard let state = value.str("state").flatMap(State.init(rawValue:)),
              let current = value.str("currentVersion"), value.str("notesUrl") != nil,
              let edition = value.str("edition"), ["desktop", "web"].contains(edition) else { return nil }
        let percent = value.dbl("percent").flatMap { $0.isFinite ? min(100, max(0, $0)) : nil }
        return ServiceUpdate(state: state, currentVersion: current, version: value.str("version"),
                             percent: percent, message: value.str("message"))
    }
}

/// One computer's service controls. Reads and mutations are never sent to another
/// active computer, including after returning from the native security sheet.
@MainActor
@Observable
public final class ServiceManagementModel {
    public let computerId: String
    public private(set) var status: ServiceStatus?
    public private(set) var update: ServiceUpdate?
    public private(set) var loading = false
    public private(set) var inFlight: ServiceAction?
    public private(set) var pendingConfirmation: ServiceAction?
    public private(set) var problem: String?
    public private(set) var notice: String?
    public private(set) var unsupported = false
    public private(set) var awaitingReconnect = false

    private let store: ComputersStore
    private var generation = 0
    private var discoveredConnection: ObjectIdentifier?
    private var observedConnection: ObjectIdentifier?

    public init(computerId: String, store: ComputersStore) {
        self.computerId = computerId
        self.store = store
    }

    public var online: Bool { store.activeId == computerId && store.conn == .online }
    public var computerName: String { store.computers.first { $0.id == computerId }?.name ?? "your computer" }
    /// Only the active store's known version, never an updater's proposed version.
    public var knownVersion: String? { store.activeId == computerId ? store.hostVersion : nil }
    public var optInInstructions: String {
        "On \(computerName), open Settings → System and turn on Manage service from phone. This can only be changed on the computer. Reading and Changes must also be enabled for this phone in Remote access → What phones can do."
    }
    public var shouldPoll: Bool {
        online && discoveredConnection != nil && status?.manageServiceFromPhone == true &&
        status?.capabilities[.updateState]?.supported == true && update?.busy == true &&
        !awaitingReconnect && inFlight == nil && !loading && problem == nil
    }

    public func disabledReason(_ action: ServiceAction) -> String? {
        guard online else { return "Connect to this computer to manage its service." }
        guard !loading, inFlight == nil else { return "Wait for the current request to finish." }
        guard !awaitingReconnect else { return "Reconnect and refresh status before another service action." }
        guard let status, discoveredConnection == currentConnection else {
            return unsupported ? "Update Nekko Agent on this computer to use service management." : "Refresh service status first."
        }
        guard status.manageServiceFromPhone else { return optInInstructions }
        guard status.capabilities[action]?.supported == true else {
            return Self.capabilityReason(status.capabilities[action]?.reason)
        }
        if action == .updateInstall, update?.state != .downloaded { return "Download an update before installing it." }
        if action == .updateDownload, update?.state != .available { return "Check for an available update before downloading it." }
        if (action == .updateCheck || action == .updateDownload || action == .updateInstall), update?.busy == true {
            return "Wait for the updater to finish."
        }
        return nil
    }

    /// Call on active-id/connection changes. Invalidates late replies and confirmations.
    public func connectionChanged() async {
        generation += 1
        status = nil
        update = nil
        discoveredConnection = nil
        pendingConfirmation = nil
        unsupported = false
        let connection = currentConnection
        if online, observedConnection != connection { awaitingReconnect = false }
        observedConnection = connection
        // Let a cancelled/stale call unwind before rediscovery on the new link.
        while loading || inFlight != nil {
            do { try await Task.sleep(nanoseconds: 100_000_000) } catch { return }
        }
        guard !Task.isCancelled else { return }
        await refresh()
    }

    /// Explicit read-only rediscovery is safe even after an uncertain mutation.
    public func refresh() async {
        guard online, !loading, inFlight == nil, let connection = currentConnection else { return }
        let epoch = generation
        loading = true
        problem = nil
        defer { loading = false }
        do {
            try await discover(connection, epoch)
            if status?.manageServiceFromPhone == true, status?.capabilities[.updateState]?.supported == true, !awaitingReconnect {
                try await readUpdate(connection, epoch)
            } else {
                update = nil
            }
        } catch {
            guard matches(connection, epoch) else { return }
            status = nil
            discoveredConnection = nil
            problem = describe(error, discovery: true)
        }
    }

    /// Polled by the visible section only while checking/downloading. On a terminal
    /// updater state, rediscover dynamic capabilities; errors stop polling.
    public func pollUpdate() async {
        guard shouldPoll, let connection = currentConnection else { return }
        let epoch = generation
        loading = true
        defer { loading = false }
        do {
            try await readUpdate(connection, epoch)
            if update?.busy == false { try await discover(connection, epoch) }
        } catch {
            guard matches(connection, epoch) else { return }
            problem = describe(error)
        }
    }

    public func request(_ action: ServiceAction) async {
        guard disabledReason(action) == nil else { return }
        if action.needsConfirmation {
            pendingConfirmation = action
        } else if action == .updateState {
            await refresh()
        } else {
            await perform(action)
        }
    }

    public func cancelConfirmation() { pendingConfirmation = nil }

    /// Consume the confirmation synchronously before SwiftUI dismisses its dialog.
    @discardableResult
    public func confirm() -> Task<Void, Never>? {
        guard let action = pendingConfirmation else { return nil }
        pendingConfirmation = nil
        guard disabledReason(action) == nil, let connection = currentConnection else { return nil }
        let epoch = generation
        inFlight = action
        return Task {
            guard matches(connection, epoch) else { inFlight = nil; return }
            await perform(action)
        }
    }

    private var currentConnection: ObjectIdentifier? {
        guard online, let remote = try? store.remote() else { return nil }
        return ObjectIdentifier(remote)
    }
    private func matches(_ connection: ObjectIdentifier, _ epoch: Int) -> Bool {
        generation == epoch && currentConnection == connection && !Task.isCancelled
    }
    private func require(_ connection: ObjectIdentifier, _ epoch: Int) throws {
        guard matches(connection, epoch) else { throw RelayError("The connection changed. Refresh this computer’s service status before trying again.") }
    }

    private func discover(_ connection: ObjectIdentifier, _ epoch: Int) async throws {
        try require(connection, epoch)
        let raw = try await store.call(read: Channels.serviceStatus, [], timeout: 10)
        try require(connection, epoch)
        guard let status = ServiceStatus.from(raw) else {
            throw RelayError("This computer sent an unsupported service response. Update Nekko Agent there.")
        }
        self.status = status
        discoveredConnection = connection
        observedConnection = connection
        unsupported = false
    }

    private func readUpdate(_ connection: ObjectIdentifier, _ epoch: Int) async throws {
        try require(connection, epoch)
        let raw = try await store.call(read: Channels.serviceUpdateState, [], timeout: 10)
        try require(connection, epoch)
        try acceptUpdate(raw)
    }

    private func acceptUpdate(_ raw: JSONValue) throws {
        guard let update = ServiceUpdate.from(raw) else { throw RelayError("This computer didn’t send a readable update status.") }
        self.update = update
        if update.state == .error { problem = update.message ?? "The updater failed. Check Nekko Agent on the computer." }
    }

    private func perform(_ action: ServiceAction) async {
        guard let connection = currentConnection else { return }
        let epoch = generation
        inFlight = action
        problem = nil
        notice = nil
        defer { inFlight = nil }
        do {
            let raw = try await signed(action, connection, epoch)
            try require(connection, epoch)
            if action.needsConfirmation {
                let expected: JSONValue = action == .restart ? ["restarting": true] : ["installing": true]
                guard raw == expected else { throw RelayError("The computer didn’t confirm acceptance of this request.") }
                awaitingReconnect = true
                status = nil
                update = nil
                discoveredConnection = nil
                notice = action == .restart
                    ? "Restart accepted, not yet verified. Reconnect and refresh service status to check that Nekko Agent is running."
                    : "Install accepted, not yet verified. Reconnect and check the version to verify installation."
            } else {
                try acceptUpdate(raw)
            }
        } catch {
            guard matches(connection, epoch) else { return }
            problem = describe(error)
            // No mutation is replayed on timeout/disconnect. Only explicit refusals
            // are eligible for a fresh proof/step-up in signed(_:_:_:).
            if !(error is ChangeRefused) {
                problem = "\(problem ?? "Request failed.") The outcome may be unknown. Refresh status before deciding whether to try again; this phone won’t retry automatically."
            }
        }
        // Support can change after check/download, even if the updater failed.
        if !action.needsConfirmation, matches(connection, epoch) {
            do { try await discover(connection, epoch) }
            catch {
                guard matches(connection, epoch) else { return }
                status = nil
                discoveredConnection = nil
                problem = [problem, describe(error, discovery: true)].compactMap { $0 }.joined(separator: " ")
            }
        }
    }

    /// The existing native StepUpPrompt and Change signer, scoped to this connection.
    /// A refused proof is spent, so every retry uses store.call(change:) afresh.
    private func signed(_ action: ServiceAction, _ connection: ObjectIdentifier, _ epoch: Int) async throws -> JSONValue {
        try require(connection, epoch)
        do {
            return try await store.call(change: action.channel, [], timeout: 60)
        } catch let e as ChangeRefused where action.needsConfirmation && e.code == StepUpCode.required.rawValue {
            guard let prompt = store.stepUpPrompt else { throw e }
            var last = e
            var problem: String?
            for attempt in 1...StepUp.maxAttempts {
                try require(connection, epoch)
                let raw = try await store.call(read: Channels.securityChallenge, [], timeout: 10)
                try require(connection, epoch)
                guard let challenge = StepUpChallenge.from(raw) else { throw RelayError("The computer didn’t send a readable security challenge.") }
                if !challenge.required { return try await store.call(change: action.channel, [], timeout: 60) }
                guard challenge.acceptsFido2 || challenge.acceptsTotp else {
                    throw ChangeRefused(code: e.code, message: "Set up a security key, passkey or code in Settings → Security on \(computerName).")
                }
                let request = StepUpRequest(action: StepUp.actionName(channel: action.channel, args: [], computer: computerName),
                                            computer: computerName, challenge: challenge, attempt: attempt, problem: problem)
                guard let proof = await prompt(request) else {
                    throw ChangeRefused(code: "step-up-cancelled", message: "Not confirmed, so nothing changed on \(computerName).")
                }
                try require(connection, epoch)
                do {
                    return try await store.call(change: action.channel, [], stepUp: proof.json, timeout: 60)
                } catch let refused as ChangeRefused where StepUp.isStepUpCode(refused.code) {
                    last = refused
                    problem = refused.message
                }
            }
            throw last
        }
    }

    private func describe(_ error: Error, discovery: Bool = false) -> String {
        let refused = error as? ChangeRefused
        let raw = (error as? RelayError)?.message ?? error.localizedDescription
        let code = refused?.code ?? PhoneRefusal(raw)?.code
        if discovery && (code == "channel-denied" || raw.lowercased().contains("unknown channel") || raw.lowercased().contains("unknown-channel")) {
            unsupported = true
            return "This computer doesn’t support service management from a phone. Update Nekko Agent on the computer."
        }
        if raw.hasPrefix("service-disabled:") { return optInInstructions }
        if raw.hasPrefix("service-unsupported:") { return "Not supported on this computer: \(raw.dropFirst("service-unsupported:".count).trimmingCharacters(in: .whitespaces))" }
        for (prefix, explanation) in [
            ("service-unavailable:", "The service is unavailable on the computer."),
            ("service-busy:", "Another service action is already in progress on the computer."),
            ("service-not-ready:", "The update is not ready to install. Refresh its status."),
            ("service-invalid:", "The computer refused this service request. Update Nekko Agent there.")
        ] where raw.hasPrefix(prefix) {
            let detail = raw.dropFirst(prefix.count).trimmingCharacters(in: .whitespaces)
            return detail.isEmpty ? explanation : "\(explanation) \(detail)"
        }
        return store.readable(error).localizedDescription
    }

    public static func capabilityReason(_ reason: String?) -> String {
        switch reason {
        case "supervisor-unavailable": return "The desktop supervisor is unavailable or busy. Check Nekko Agent on the computer."
        case "native-updater-unavailable": return "This host has no native desktop updater. Update it locally."
        case "app-not-packaged": return "Update checks and downloads require a packaged app on the computer."
        case "update-feed-unavailable": return "The update feed is unavailable on the computer."
        case "packaged-install-required": return "Remote installation requires a packaged Nekko Agent installation."
        case "interactive-package-install", "interactive-admin-install": return "This update needs local approval. Install it on the computer."
        case "install-layout-unsupported": return "This installation layout cannot be updated safely from a phone. Update it locally."
        case "install-already-requested": return "An installation was already requested. Check the computer locally before another action."
        default: return "This action isn’t supported by this computer."
        }
    }
}
