import Foundation
import NekkoProtocol
import Observation

/// Secrets live here only (the Keychain in the app, a dictionary in tests).
public protocol SecureStore: AnyObject, Sendable {
    func get(_ key: String) -> String?
    func set(_ key: String, _ value: String?)
}

/// Something that can call the computer's channels: the relay client, or a fake.
public protocol Caller: AnyObject, Sendable {
    func call(_ channel: String, _ args: [JSONValue], timeout: TimeInterval?) async throws -> JSONValue
}

extension Caller {
    public func call(_ channel: String, _ args: [JSONValue] = []) async throws -> JSONValue {
        try await call(channel, args, timeout: nil)
    }
}

/// What the store needs of a live connection; `RelayClient` in the app.
public protocol RemoteConnection: Caller {
    func setHandlers(onStatus: (@Sendable (RelayStatus) -> Void)?, onEvent: (@Sendable (String, JSONValue) -> Void)?,
                     onWelcome: (@Sendable (WelcomedDevice) -> Void)?)
    func connect()
    func close()
    func nudge()
    func reconnect()
    func registerPush(token: String) async throws
    /// `kinds`: the pushes this phone wants; nil asks for all.
    func registerPush(token: String, kinds: [String]?) async throws
    /// The Live Activity card's push tokens and level (`RelayClient.registerCard`).
    func registerCard(token: String?, startToken: String?, level: LiveLevel, computerId: String, computerName: String) async throws
    /// Frames from the relay itself (`RelayControl`).
    func setControlHandler(_ f: (@Sendable (RelayControl) -> Void)?)
    /// The phone moved to another network (`RelayClient.networkChanged`).
    func networkChanged(_ path: NetworkPath)
    /// The network the phone is on, without moving (`RelayClient.setNetworkPath`).
    func setNetworkPath(_ path: NetworkPath)
}

extension RemoteConnection {
    public func registerPush(token: String, kinds: [String]?) async throws { try await registerPush(token: token) }
    public func setControlHandler(_ f: (@Sendable (RelayControl) -> Void)?) {}
    /// A connection with one route only has to dial again.
    public func networkChanged(_ path: NetworkPath) { reconnect() }
    public func setNetworkPath(_ path: NetworkPath) {}
}

extension RelayClient: RemoteConnection {}

/// A paired computer, as listed. No secrets.
public struct Computer: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public var name: String
    public var relayUrl: String
    public let pairedAt: Int64
    public var platform: String?
    /// Other addresses of the same relay, from the pairing link (TASKS.md IO-20).
    public var alts: [String]
    /// Its `machineIcon`, learned from `app:info` once connected. Nil shows nothing.
    public var icon: String?
    /// True only for a phone-local nickname; nil migrates older saved names.
    public var nameIsCustom: Bool?

    public init(id: String, name: String, relayUrl: String, pairedAt: Int64, platform: String? = nil, alts: [String] = [], icon: String? = nil) {
        self.id = id
        self.name = name
        self.relayUrl = relayUrl
        self.pairedAt = pairedAt
        self.platform = platform
        self.alts = alts
        self.icon = icon
        self.nameIsCustom = nil
    }

    /// Pairings saved before routes existed have no `alts`.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        relayUrl = try c.decode(String.self, forKey: .relayUrl)
        pairedAt = try c.decode(Int64.self, forKey: .pairedAt)
        platform = try c.decodeIfPresent(String.self, forKey: .platform)
        alts = try c.decodeIfPresent([String].self, forKey: .alts) ?? []
        icon = try c.decodeIfPresent(String.self, forKey: .icon)
        nameIsCustom = try c.decodeIfPresent(Bool.self, forKey: .nameIsCustom)
    }

    /// Every address, best first (the order the client tries them).
    public var routes: [String] { RouteSupervisor.order([relayUrl] + alts) }
    public var route: RelayRoute { RelayRoute.of(relayUrl) }
    public var relayHost: String { Pairing.relayHost(relayUrl) }
}

/// Pairing material for one computer, stored as one Keychain item.
struct ComputerSecret: Codable, Equatable {
    var room: String
    var key: String
    /// The PBKDF2-derived AES key, so reconnects skip the second of derivation.
    var keyHex: String
    /// The one-time code, until the computer has welcomed this phone once.
    var pair: String?
    /// The computer's public key, pinned from the pairing link (decision 0041).
    var hostKey: String?
    /// `E2E.pairingVersion` when saved; `nil` from an older app, which must pair again (decision 0036).
    var v: Int?

    /// The key to dial with; nil on a pairing that must be made again. Never a first-seen key.
    var pinned: String? { (v ?? 1) < E2E.pairingVersion ? nil : hostKey }
}

public struct ModelGroup: Equatable, Sendable, Identifiable {
    public let provider: PublicProvider
    public let models: [ModelInfo]?
    public let error: String?
    public var id: String { provider.id }
}

public let defaultComputerName = "My computer"

/// Fallback for older computers that report a platform but no hostname.
public func osName(_ platform: String?) -> String {
    switch platform {
    case "win32": return "Windows PC"
    case "darwin": return "Mac"
    case "linux": return "Linux PC"
    default: return defaultComputerName
    }
}

/// Computers this phone is paired with, and the live connection to the active
/// one. A port of Android's `ComputersRepository` (itself a port of the Expo
/// app's `services/computers.ts`). Pairing material lives in `SecureStore`
/// only; views read the non-secret parts. The active computer (the one you're
/// looking at) has the full connection; with `stayConnected` every other paired
/// computer keeps a link of its own beside it (the fleet, `Fleet.swift`).
@MainActor
@Observable
public final class ComputersStore {
    public static let indexKey = "nekko.computers"
    public static let activeKey = "nekko.activeComputer"
    public static let deviceKey = "nekko.deviceId"
    static func secretKey(_ id: String) -> String { "nekko.computer.\(id)" }

    // MARK: State (read by views)

    public private(set) var ready = false
    public private(set) var computers: [Computer] = []
    public private(set) var activeId: String?
    public private(set) var conn: RelayState = .idle
    public private(set) var connDetail: String?
    public private(set) var denied: DenyReason?
    public private(set) var summaries: [SessionSummary] = []
    public private(set) var summariesLoading = false
    /// The list has been read (or failed to) since connecting: before that an
    /// empty list means "not loaded yet", not "no chats".
    public private(set) var summariesLoaded = false
    public private(set) var providers: [PublicProvider] = []
    public private(set) var defaults = RemoteDefaults()
    public private(set) var appearance: Appearance?
    public private(set) var pcSettings = PcSettings()
    public private(set) var workspaces: [WorkspaceFolder] = []
    public private(set) var activity: [String: Activity] = [:]
    /// Each listed chat's pull requests (`pr:sessionList`) for its row: only chats whose transcript names one.
    public private(set) var rowPrs: [String: [PullRequest]] = [:]
    /// When each chat's row PRs were asked for, and the links it named then.
    @ObservationIgnored private var rowPrsAsked: [String: (urls: [String], at: Int64)] = [:]
    public private(set) var models: [String: [ModelInfo]] = [:]
    public private(set) var modelErrors: [String: String] = [:]
    public private(set) var hostVersion: String?
    /// The active computer's phone protocol version, once it has welcomed this phone (IO-32).
    public private(set) var hostProtocol: Int?
    /// Whether the active computer's relay said it can push to this phone; nil until it says.
    public private(set) var relayDelivers: Bool?
    /// The pushes this phone wants (IO-30); nil asks for every kind. Re-registers when it changes.
    public var pushKinds: [PushKind]? {
        didSet { if pushKinds != oldValue { registerPushNow() } }
    }
    /// The Live Activity card's level and its ActivityKit push tokens (the card
    /// that is up, and the one that starts a card). On every connect and change
    /// they go to the relay, and the level to the computer (`card:set`), which
    /// then sends the card for the relay to push while iOS has suspended the app.
    public var cardLevel: LiveLevel = .none {
        didSet { if cardLevel != oldValue { registerCardNow(level: true) } }
    }
    public var cardToken: String? {
        didSet { if cardToken != oldValue { registerCardNow(level: false) } }
    }
    public var cardStartToken: String? {
        didSet { if cardStartToken != oldValue { registerCardNow(level: false) } }
    }
    /// An approval or a question was handled somewhere: remove the needs-you
    /// notification for the chat with this tag (`E2E.activityTag`).
    public var onDismiss: ((String) -> Void)?
    public private(set) var lastError: String?
    /// The active computer's connection history (memory only, content-free), for the Connection screen.
    public private(set) var connectionLog = ConnectionLog()
    /// The relay address in use or being dialed (one of the active computer's routes).
    public private(set) var route: String?
    /// The network the phone is on, as last reported.
    public private(set) var networkPath: NetworkPath = .unknown
    /// The socket was closed after the background grace; it comes back on foreground.
    public private(set) var suspended = false
    /// Settings → Connection → Check routes: one report per route, best first.
    public private(set) var checks: [RouteReport] = []
    public private(set) var checking = false
    /// When the list on screen is the phone's saved copy (not yet re-read from
    /// the computer), when it was saved; nil once the computer has answered.
    public private(set) var savedListAt: Int64?
    /// The active computer lets a phone quit Nekko Agent on it (`app:info`
    /// `quitFromPhone`, SK-3): only then does the phone offer *Quit*.
    public private(set) var quitFromPhone = false
    /// A safety exit this phone used (SK-8): why the connection ended, for the banner.
    public private(set) var safetyExit: SafetyExit?
    /// Computers this phone signed out of that haven't heard yet (SK-8), by name.
    public private(set) var pendingSignOuts: [String] = []
    /// Every paired computer other than the active one, kept connected beside it
    /// (2026-11-04): its state, its chats and which of them run or need you.
    public internal(set) var peers: [String: Peer] = [:]
    /// Keep a link open to every paired computer, not only the active one.
    public let stayConnected: Bool
    @ObservationIgnored var links: [String: PeerLink] = [:]
    /// Set while *Keep the chat list when offline* is on (the default); nil keeps nothing.
    public var chatListCache: ChatListCache? {
        didSet { if chatListCache == nil { savedListAt = nil } else { saveList() } }
    }
    /// The active computer's recently opened chats, kept to read offline (OF-5).
    public let transcripts: SavedTranscripts
    /// Set while *Keep recent chats to read offline* is on (the default); nil
    /// keeps none. Turning it off deletes every saved chat, on every computer.
    public var transcriptCache: TranscriptCache? {
        didSet {
            guard transcriptCache !== oldValue else { return }
            if transcriptCache == nil { oldValue?.removeAll() }
            transcripts.use(transcriptCache, computerId: offlineComputer)
        }
    }
    private var loggedComputer: String?
    /// The active computer's drafts (every chat's composer and New chat's), kept on disk.
    public let drafts: DraftStore
    /// The active computer's prompts waiting to be delivered, kept on disk.
    public let outbox: Outbox
    private let offlineFiles: OfflineFiles?

    public var active: Computer? { computers.first { $0.id == activeId } }
    /// Which side to update when the phone and the computer speak different versions.
    public var protocolCheck: ProtocolCheck { ProtocolCheck.compare(computer: hostProtocol) }
    public var groups: [ChatGroup] { ChatGroup.of(summaries, folders: workspaces) }
    public var needsYouCount: Int { activity.values.filter { $0 == .needsYou }.count }
    public var runningCount: Int { activity.values.filter { $0 == .running }.count }
    public var modelGroups: [ModelGroup] {
        providers.filter(\.enabled).map { ModelGroup(provider: $0, models: models[$0.id], error: modelErrors[$0.id]) }
    }

    // MARK: Wiring

    private let store: SecureStore
    let makeConnection: @MainActor (RelayConfig) -> RemoteConnection
    private let deviceName: () -> String
    private let deriveKey: @Sendable (String, String) async -> Data
    private let newId: () -> String
    let now: () -> Int64
    let summariesDebounce: TimeInterval
    private let modelListTimeout: TimeInterval
    private let platform: String
    private let app: String?
    private let probeNetwork: ProbeNetwork
    /// Signs Change actions (IO-33): the Secure Enclave in the app; nil where there is none.
    @ObservationIgnored public var changeSigner: ChangeSigner?
    /// Signs every relay HELLO (decision 0036): the Secure Enclave device key in the app, a software key in tests.
    @ObservationIgnored public var helloSigner: HelloSigner?
    /// Asks the owner for a step-up (SK-6): the app's sheet; nil where there is none.
    @ObservationIgnored public var stepUpPrompt: StepUpPrompt?
    @ObservationIgnored private var flushingSignOuts = false
    @ObservationIgnored private var changeCalls: (client: ObjectIdentifier, calls: ChangeCalls)?

    var client: RemoteConnection?
    private var graceTask: Task<Void, Never>?
    private var generation = 0
    private var pump: Task<Void, Never>?
    private var summariesTask: Task<Void, Never>?
    private var summariesDirty = false
    private var listeners: [UUID: (AgentEvent) -> Void] = [:]
    /// Open terminal screens (IO-33 FA-3): the computer sends only the output of terminals this phone opened.
    private var terminalListeners: [UUID: (TerminalEvent) -> Void] = [:]
    private var pushToken: String?
    /// Whose drafts and outbox are loaded.
    private var offlineComputer: String?

    public init(store: SecureStore,
                makeConnection: @escaping @MainActor (RelayConfig) -> RemoteConnection,
                deviceName: @escaping () -> String,
                platform: String = "ios",
                app: String? = nil,
                deriveKey: @escaping @Sendable (String, String) async -> Data = { s, r in
                    await Task.detached(priority: .userInitiated) { E2E.deriveKey(secret: s, room: r) }.value
                },
                newId: @escaping () -> String = { UUID().uuidString.lowercased() },
                now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
                summariesDebounce: TimeInterval = 0.6,
                modelListTimeout: TimeInterval = 6,
                offlineFiles: OfflineFiles? = nil,
                draftDebounce: TimeInterval = 0.5,
                outboxPoll: TimeInterval = 0.5,
                outboxConfirmTimeout: TimeInterval = 45,
                transcripts: SavedTranscripts? = nil,
                probeNetwork: ProbeNetwork = PosixProbeNetwork(),
                stayConnected: Bool = false) {
        self.store = store
        self.stayConnected = stayConnected
        self.probeNetwork = probeNetwork
        self.makeConnection = makeConnection
        self.deviceName = deviceName
        self.platform = platform
        self.app = app
        self.deriveKey = deriveKey
        self.newId = newId
        self.now = now
        self.summariesDebounce = summariesDebounce
        self.modelListTimeout = modelListTimeout
        self.offlineFiles = offlineFiles
        self.transcripts = transcripts ?? SavedTranscripts(now: now)
        let drafts = DraftStore(files: offlineFiles, debounce: draftDebounce)
        self.drafts = drafts
        var reach: () -> Caller? = { nil }
        var defaultsNow: () -> RemoteDefaults = { RemoteDefaults() }
        outbox = Outbox(files: offlineFiles, drafts: drafts, caller: { reach() }, defaults: { defaultsNow() },
                        newId: newId, now: now, pollInterval: outboxPoll, confirmTimeout: outboxConfirmTimeout)
        reach = { [weak self] in
            guard let self, self.conn == .online else { return nil }
            return self.client
        }
        defaultsNow = { [weak self] in self?.defaults ?? RemoteDefaults() }
        outbox.onDelivered = { [weak self] _, _ in self?.scheduleSummaries() }
    }

    /// Deliver the outbox now (connected, back in the foreground, Send now).
    public func flushOutbox() {
        guard conn == .online, !outbox.items.isEmpty else { return }
        Task { await outbox.flush() }
    }

    /// Calls the active computer at call time; throws when none is connected.
    public func remote() throws -> RemoteConnection {
        guard let client else { throw RelayError("Not connected to a computer.") }
        return client
    }

    /// A Change action on the active computer (IO-33): signed with this
    /// phone's key (Face ID or the passcode within the last 5 minutes), the
    /// key registered on first use. Refusals throw `ChangeRefused` with a
    /// message to show, e.g. "Changes from this phone are turned off on Studio".
    public func call(change channel: String, _ args: [JSONValue] = [], stepUp: JSONValue? = nil,
                     timeout: TimeInterval? = nil) async throws -> JSONValue {
        guard let client else { throw RelayError("Not connected to a computer.") }
        guard let signer = changeSigner, let caller = client as? ProofCaller else {
            throw ChangeRefused(code: nil, message: "This phone can’t confirm changes with Face ID or a passcode.")
        }
        let id = ObjectIdentifier(client)
        let calls: ChangeCalls
        if let cached = changeCalls, cached.client == id {
            calls = cached.calls
        } else {
            calls = ChangeCalls(caller: caller, signer: signer, deviceId: deviceId(), computerName: active?.name ?? "your computer")
            changeCalls = (id, calls)
        }
        return try await calls.call(change: channel, args, stepUp: stepUp, timeout: timeout)
    }

    /// A Read action on the active computer (IO-33): a plain call, with the
    /// computer's refusals (`read-off`, `channel-denied`, ...) said plainly.
    public func call(read channel: String, _ args: [JSONValue] = [], timeout: TimeInterval? = nil) async throws -> JSONValue {
        do {
            return try await remote().call(channel, args, timeout: timeout)
        } catch {
            throw readable(error)
        }
    }

    /// A call that may raise a chat's tool policy: `session:setOptions` with a
    /// more permissive `mode`, or `settings:update` raising `defaultChatMode`
    /// (ask < guardrails < yolo). Sent plain first; when the computer answers
    /// `proof-required` (it was a raise), sent again signed, so the phone asks
    /// for Face ID or the passcode (`call(change:)`). Lowering or keeping the
    /// mode never asks. When the computer also wants a step-up (SK-6), the
    /// step-up sheet is shown and the call sent once more with it
    /// (`call(guarded:)`).
    public func call(raising channel: String, _ args: [JSONValue], timeout: TimeInterval? = nil) async throws -> JSONValue {
        do {
            return try await remote().call(channel, args, timeout: timeout)
        } catch let e as RelayError where e.fromComputer && PhoneRefusal(e.message)?.code == "proof-required" {
            return try await call(guarded: channel, args, timeout: timeout)
        } catch {
            throw readable(error)
        }
    }

    /// A guarded action (SK-6): signed like any Change; when the computer
    /// answers `step-up-required`, a fresh challenge (`security:challenge`),
    /// the step-up sheet, and the same call again with the answer beside the
    /// proof. A turned-down answer (wrong code, a slow touch) shows the sheet
    /// again with the computer's reason, up to `StepUp.maxAttempts`. The
    /// five-minute window is the computer's: the phone sends no step-up
    /// until it is asked, and keeps none.
    public func call(guarded channel: String, _ args: [JSONValue], timeout: TimeInterval? = nil) async throws -> JSONValue {
        do {
            return try await call(change: channel, args, timeout: timeout)
        } catch let e as ChangeRefused where e.code == StepUpCode.required.rawValue {
            return try await withStepUp(channel, args, timeout: timeout)
        }
    }

    private func withStepUp(_ channel: String, _ args: [JSONValue], timeout: TimeInterval?) async throws -> JSONValue {
        let name = active?.name ?? "your computer"
        guard let prompt = stepUpPrompt else {
            throw ChangeRefused(code: StepUpCode.required.rawValue,
                                message: "\(name) asks for a security key or a code for this, and this iPhone can’t ask for one. Do it on \(name).")
        }
        var problem: String?
        var last = ChangeRefused(code: StepUpCode.required.rawValue, message: StepUpCode.required.message(computer: name))
        for attempt in 1...StepUp.maxAttempts {
            let reply = try await call(read: Channels.securityChallenge)
            guard let challenge = StepUpChallenge.from(reply) else {
                throw ChangeRefused(code: nil, message: "\(name) didn’t send a challenge for your security key. Update Nekko Agent on \(name).")
            }
            // Turned off on the computer meanwhile: the signed call is enough.
            if !challenge.required { return try await call(change: channel, args, timeout: timeout) }
            guard challenge.acceptsFido2 || challenge.acceptsTotp else {
                throw ChangeRefused(code: StepUpCode.required.rawValue,
                                    message: "\(name) asks for a security key or a code, but none it has can be used from this iPhone. Check Settings → Security on \(name).")
            }
            let chats = summaries
            let action = StepUp.actionName(channel: channel, args: args, computer: name) { id in
                chats.first { $0.id == id }?.title
            }
            let request = StepUpRequest(action: action, computer: name, challenge: challenge, attempt: attempt, problem: problem)
            guard let proof = await prompt(request) else {
                throw ChangeRefused(code: "step-up-cancelled", message: "Not confirmed, so nothing changed on \(name).")
            }
            do {
                return try await call(change: channel, args, stepUp: proof.json, timeout: timeout)
            } catch let e as ChangeRefused where StepUp.isStepUpCode(e.code) {
                last = e
                problem = e.message
            }
        }
        throw last
    }

    // MARK: Security (SK-6)

    /// Settings → Security: whether the active computer asks for a step-up and
    /// the kinds of method it has (never which ones), with the offer to
    /// register from this phone when it makes one. Spends one challenge.
    public func stepUpStatus() async throws -> StepUpChallenge {
        let reply = try await call(read: Channels.securityChallenge)
        guard let status = StepUpChallenge.from(reply) else {
            throw RelayError("\(active?.name ?? "Your computer") didn’t say how it’s protected. Update Nekko Agent on it.")
        }
        return status
    }

    /// Hand a key or passkey this phone just registered to the computer that
    /// offered it, as a guarded change (so a step-up is asked when it is on).
    public func register(_ credential: StepUpRegistration, offer: StepUpRegistrationOffer) async throws {
        _ = try await call(guarded: offer.channel, [credential.json])
    }

    // MARK: Safety exits (SK-8)

    /// *Stop remote access on the computer*: `remote:stop` (no proof, no
    /// step-up). The computer turns remote access off and drops every phone;
    /// only the desktop can turn it back on.
    public func stopRemoteAccess() async throws {
        try await useSafetyExit(Channels.remoteStop, kind: .stoppedRemote)
    }

    /// *Quit Nekko Agent on the computer*: `app:quit`. Refused
    /// `quit-disabled` unless the owner allowed it there (`quitFromPhone`).
    public func quitComputer() async throws {
        try await useSafetyExit(Channels.appQuit, kind: .quit)
    }

    private func useSafetyExit(_ channel: String, kind: SafetyExit.Kind) async throws {
        guard let id = activeId else { throw RelayError("Not connected to a computer.") }
        do {
            _ = try await remote().call(channel, [], timeout: 15)
        } catch let e as RelayError where !e.fromComputer && activeId == id && conn != .online {
            // The computer dropped this phone before its answer arrived: that is the exit working.
            guard kind == .stoppedRemote || conn == .offline else { throw e }
        } catch {
            throw readable(error)
        }
        safetyExit = SafetyExit(computerId: id, kind: kind, at: now())
    }

    /// *Sign out this phone*: tell the computer (`device:signOut`, which
    /// revokes this phone there) when it can be reached now, and forget it
    /// here either way: pairing material, drafts, outbox, saved chats and
    /// files. Unheard, the sign-out waits in the Keychain and goes on the next
    /// connection (`flushSignOuts`). Returns whether the computer heard it now.
    @discardableResult
    public func signOut(_ id: String) async -> Bool {
        guard let computer = computers.first(where: { $0.id == id }), let secret = secret(id) else { return false }
        var heard = false
        if id == activeId, conn == .online, let c = client {
            do {
                _ = try await c.call(Channels.deviceSignOut, [], timeout: 8)
                heard = true
            } catch let e as RelayError where e.fromComputer {
                // It answered, so it knows (an unknown phone has nothing to sign out of).
                heard = true
            } catch {
                heard = false
            }
        }
        // A phone the computer never welcomed (it still holds a pairing code) is unknown there,
        // and a pairing from before the host key can't reach it.
        if !heard && secret.pair == nil, let hostKey = secret.pinned {
            var list = decodeSignOuts().filter { $0.computerId != id }
            list.append(PendingSignOut(computerId: id, name: computer.name, relayUrl: computer.relayUrl, alts: computer.alts,
                                       room: secret.room, key: secret.key, keyHex: secret.keyHex, hostKey: hostKey, at: now()))
            saveSignOuts(list)
        }
        forget(id)
        return heard
    }

    /// Send the sign-outs that wait (SK-8): one short connection each, only
    /// for `device:signOut`, then closed. Called on load, on return to the
    /// foreground and after a network change. Dropped once the computer
    /// answers or turns this phone away (it is already signed out there).
    public func flushSignOuts(timeout: TimeInterval = 10) async {
        guard !flushingSignOuts else { return }
        let list = decodeSignOuts()
        guard !list.isEmpty else { return }
        flushingSignOuts = true
        defer { flushingSignOuts = false }
        var done: Set<String> = []
        for p in list {
            guard let keyBytes = E2E.fromHex(p.keyHex), let hostKey = p.hostKey else {
                done.insert(p.computerId)
                continue
            }
            var config = RelayConfig(relayUrl: p.relayUrl, room: p.room, key: p.key, hostKey: hostKey, keyBytes: keyBytes,
                                     deviceId: deviceId(), deviceName: deviceName(), pairCode: nil, platform: platform)
            config.alternates = p.alts
            config.helloSigner = helloSigner
            config.app = app
            if await Self.deliverSignOut(makeConnection(config), timeout: timeout) { done.insert(p.computerId) }
        }
        // Signed out of again meanwhile: keep the newer record.
        saveSignOuts(decodeSignOuts().filter { !(done.contains($0.computerId) && list.contains($0)) })
    }

    /// One sign-out on its own socket: open, wait for the computer (or
    /// `timeout`), send, close. True when nothing is left to send.
    static func deliverSignOut(_ c: RemoteConnection, timeout: TimeInterval) async -> Bool {
        let box = HelloBox()
        let s: RelayStatus? = await withCheckedContinuation { (cont: CheckedContinuation<RelayStatus?, Never>) in
            box.cont = cont
            c.setHandlers(onStatus: { s in if s.state == .online || s.state == .denied { box.finish(s) } }, onEvent: nil, onWelcome: nil)
            c.connect()
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { box.finish(nil) }
        }
        defer { c.close() }
        switch s?.state {
        case .denied?:
            // Revoked, removed or unknown there: already signed out. An app too old to be let in can't say it yet.
            return s?.denied != .updateRequired
        case .online?:
            do {
                _ = try await c.call(Channels.deviceSignOut, [], timeout: 8)
                return true
            } catch let e as RelayError where e.fromComputer {
                return true
            } catch {
                return false
            }
        default:
            return false
        }
    }

    private static let signOutsKey = "nekko.pendingSignOuts"

    private func decodeSignOuts() -> [PendingSignOut] {
        store.get(Self.signOutsKey).flatMap { try? JSONDecoder().decode([PendingSignOut].self, from: Data($0.utf8)) } ?? []
    }

    private func saveSignOuts(_ list: [PendingSignOut]) {
        let data = list.isEmpty ? nil : (try? JSONEncoder().encode(list)).map { String(decoding: $0, as: UTF8.self) }
        store.set(Self.signOutsKey, data)
        pendingSignOuts = list.map(\.name)
    }

    /// The computer's refusal of a plain call (`change-off`, `read-off`, ...)
    /// as a `ChangeRefused` with its plain message; any other error as it was.
    public func readable(_ error: Error) -> Error {
        guard let e = error as? RelayError, e.fromComputer, let r = PhoneRefusal(e.message),
              let m = r.message(computer: active?.name ?? "your computer") else { return error }
        return ChangeRefused(code: r.code, message: m)
    }

    /// Every `agent:event` from the active computer. Returns an id for `unsubscribe`.
    public func subscribe(_ f: @escaping (AgentEvent) -> Void) -> UUID {
        let id = UUID()
        listeners[id] = f
        return id
    }

    public func unsubscribe(_ id: UUID) { listeners[id] = nil }

    /// Every `terminal:event` from the active computer (`TerminalSession`). Returns an id for `unsubscribeTerminal`.
    public func subscribeTerminal(_ f: @escaping (TerminalEvent) -> Void) -> UUID {
        let id = UUID()
        terminalListeners[id] = f
        return id
    }

    public func unsubscribeTerminal(_ id: UUID) { terminalListeners[id] = nil }

    // MARK: Pairing

    /// Read the paired computers and connect to `preferredId` when still paired,
    /// else the one used last, else the first.
    public func load(preferredId: String? = nil) {
        computers = decodeIndex()
        let ids = computers.map(\.id)
        let last = store.get(Self.activeKey)
        activeId = [preferredId, last].compactMap { $0 }.first { ids.contains($0) } ?? ids.first
        ready = true
        pendingSignOuts = decodeSignOuts().map(\.name)
        if let activeId { connect(activeId) }
        if !pendingSignOuts.isEmpty { Task { await flushSignOuts() } }
    }

    /// Save a scanned/pasted pairing and connect. Returns the computer's id.
    /// Throws `PairingRefusal` for a link with no host key, or one that would replace a pin.
    @discardableResult
    public func pair(_ link: PairingLink) async throws -> String {
        guard let hostKey = link.hostKey else { throw PairingRefusal.noHostKey }
        // Re-scanning a computer we already know keeps its id and name.
        let sameRoute = computers.last { c in c.relayUrl == link.relayUrl && secret(c.id)?.room == link.room }
        if let pinned = sameRoute.flatMap({ secret($0.id)?.pinned }), pinned != hostKey { throw PairingRefusal.differentComputer }
        let existing = computers.last { secret($0.id)?.pinned == hostKey } ?? sameRoute
        if let pinned = existing.flatMap({ secret($0.id)?.pinned }), pinned != hostKey { throw PairingRefusal.differentComputer }
        let keyHex = E2E.toHex(await deriveKey(link.key, link.room))
        let id = existing?.id ?? newId()
        saveSecret(id, ComputerSecret(room: link.room, key: link.key, keyHex: keyHex, pair: link.pair, hostKey: hostKey, v: E2E.pairingVersion))
        if existing == nil {
            computers.append(Computer(id: id, name: defaultComputerName, relayUrl: link.relayUrl, pairedAt: now(), alts: link.alts))
            saveIndex()
        } else if let i = computers.firstIndex(where: { $0.id == id }) {
            // A fresh QR carries the computer's routes as they are now.
            computers[i].relayUrl = link.relayUrl
            computers[i].alts = link.alts
            saveIndex()
        }
        dropLink(id) // A fleet link still holds the old credentials and routes.
        connect(id)
        return id
    }

    public func rename(_ id: String, to name: String) {
        let trimmed = String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(40))
        guard !trimmed.isEmpty, let i = computers.firstIndex(where: { $0.id == id }) else { return }
        computers[i].name = trimmed
        computers[i].nameIsCustom = true
        saveIndex()
    }

    public func forget(_ id: String) {
        let wasActive = activeId == id
        if wasActive { disconnect() } else { dropLink(id) }
        store.set(Self.secretKey(id), nil)
        chatListCache?.remove(id)
        if wasActive {
            drafts.load(nil)
            outbox.load(nil)
            transcripts.load(nil)
            offlineComputer = nil
        }
        offlineFiles?.remove(id)
        transcriptCache?.removeComputer(id)
        computers.removeAll { $0.id == id }
        saveIndex()
        if wasActive {
            activeId = computers.first?.id
            store.set(Self.activeKey, activeId)
            clearComputerState()
            denied = nil
            if computers.isEmpty { appearance = nil }
            if let next = activeId { connect(next) }
        }
    }

    // MARK: Connection

    /// Make `id` the active computer and (re)connect to it. With `stayConnected`
    /// the computer left behind keeps its link in the fleet, and a computer the
    /// fleet already reaches is taken over as it is, with no new connection.
    public func connect(_ id: String) {
        defer { syncFleet() }
        let leaving = id != activeId ? active : nil
        // The computer left behind must not push (or start) a card on this phone any more:
        // tell it and its relay, best effort, then close that connection (or hand it to
        // the fleet). The switch never waits.
        if let computer = leaving, let old = client, conn == .online || stayConnected {
            client = nil
            let keep = stayConnected
            if conn == .online {
                Task {
                    try? await old.registerCard(token: nil, startToken: nil, level: .none, computerId: computer.id, computerName: computer.name)
                    _ = try? await old.call(Channels.cardSet, [["level": "none"]], timeout: 3)
                    if !keep { old.close() }
                }
            }
            if keep { adopt(computer.id, old, as: leftBehind(), suspended: suspended) }
        }
        disconnect()
        guard let computer = computers.first(where: { $0.id == id }), let secret = secret(id),
              let keyBytes = E2E.fromHex(secret.keyHex) else { return }
        // Already reached by the fleet: carry on with its link and what it knows.
        let taken = stayConnected ? takeLink(id) : nil
        store.set(Self.activeKey, id)
        if offlineComputer != id {
            drafts.load(id)
            outbox.load(id)
            transcripts.load(id)
            offlineComputer = id
        }
        activeId = id
        conn = .connecting
        denied = nil
        connDetail = nil
        if loggedComputer != id {
            connectionLog.clear()
            checks = []
            loggedComputer = id
        }
        route = nil
        connectionLog.record(.connecting)
        clearComputerState()
        guard let hostKey = secret.pinned else {
            // Paired before the computer replaced its pairing secret (decision 0036) or could prove
            // itself (decision 0041): it no longer answers on this pairing, so ask for a fresh QR
            // instead of dialing.
            conn = .denied
            denied = .badKey
            connectionLog.record(.denied, denied: .badKey)
            taken?.client.close()
            return
        }
        if let peer = taken?.peer {
            // The fleet's list and who is running stay on screen while the computer is read again.
            activity = peer.activity
            if peer.loaded {
                summaries = peer.summaries
                workspaces = peer.workspaces
                summariesLoaded = true
            }
        }
        // Opening the app away from the computer: show the list as it was, marked as saved.
        if taken?.peer.loaded != true, let saved = chatListCache?.load(id) {
            summaries = saved.summaries
            workspaces = saved.folders
            savedListAt = saved.savedAt
        }
        let c: RemoteConnection
        if let taken {
            c = taken.client
        } else {
            c = makeConnection(relayConfig(computer, secret, hostKey: hostKey, keyBytes: keyBytes))
            if networkPath != .unknown { c.setNetworkPath(networkPath) }
        }
        generation += 1
        let gen = generation
        client = c
        let (stream, sink) = AsyncStream<Signal>.makeStream(bufferingPolicy: .unbounded)
        c.setHandlers(
            onStatus: { sink.yield(.status($0)) },
            onEvent: { sink.yield(.event($0, $1)) },
            onWelcome: { sink.yield(.welcome($0.protocolVersion)) })
        c.setControlHandler { sink.yield(.control($0)) }
        // One consumer, in arrival order, on the main actor.
        pump = Task { @MainActor [weak self] in
            for await signal in stream {
                guard let self, self.generation == gen else { return }
                self.handle(signal, computerId: id, hadCode: secret.pair != nil)
            }
        }
        guard let taken else { return c.connect() }
        hostProtocol = taken.peer.hostProtocol
        // Its state as the fleet last heard it: online reads the computer and delivers what waits.
        if taken.peer.conn != .idle {
            conn = taken.peer.conn
            connDetail = taken.peer.detail
            sink.yield(.status(RelayStatus(taken.peer.conn, detail: taken.peer.detail, denied: taken.peer.denied)))
        }
        if taken.suspended { c.connect() }
    }

    /// The relay settings for one paired computer, the active one's or a fleet link's.
    func relayConfig(_ computer: Computer, _ secret: ComputerSecret, hostKey: String, keyBytes: Data) -> RelayConfig {
        var config = RelayConfig(relayUrl: computer.relayUrl, room: secret.room, key: secret.key, hostKey: hostKey, keyBytes: keyBytes,
                                 deviceId: deviceId(), deviceName: deviceName(), pairCode: secret.pair, platform: platform)
        config.alternates = computer.alts
        config.helloSigner = helloSigner
        config.requestTimeout = 120
        config.app = app
        return config
    }

    /// What the active computer's link knows, handed to the fleet when another computer becomes active.
    private func leftBehind() -> Peer {
        Peer(conn: conn, detail: connDetail, denied: denied, summaries: summaries, activity: activity,
             workspaces: workspaces, loaded: summariesLoaded && savedListAt == nil, hostProtocol: hostProtocol)
    }

    private enum Signal: Sendable {
        case status(RelayStatus)
        case event(String, JSONValue)
        case welcome(Int)
        case control(RelayControl)
    }

    private func handle(_ signal: Signal, computerId: String, hadCode: Bool) {
        switch signal {
        case .status(let s):
            conn = s.state
            connDetail = s.detail
            if let r = s.route { route = r }
            // The log names the route when the computer has more than one.
            let via = (active?.alts.isEmpty ?? true) ? nil : s.route.map(Pairing.relayHost)
            connectionLog.record(s.state, detail: s.detail, denied: s.denied, via: via)
            if let d = s.denied {
                denied = d
                // Never delivered now: each prompt goes back to its composer, saying why.
                outbox.handBackAll(reason: "This phone is no longer paired with \(active?.name ?? "your computer").")
            }
            if s.state == .online {
                // Back on: whatever stopped it from this phone is over.
                if safetyExit?.computerId == computerId { safetyExit = nil }
                Task {
                    await refresh()
                    await outbox.flush()
                }
                registerPushNow()
                registerCardNow(level: true)
            }
        case .welcome(let version):
            hostProtocol = version
            // Enrollment done: the one-time code must never be sent again.
            if hadCode { dropPairCode(computerId) }
        case .control(.pushRegistered(let delivers)):
            relayDelivers = delivers
        case .control(.dismiss(let tag)):
            onDismiss?(tag)
        case .event(let channel, let payload):
            if channel == Events.appearanceUpdated {
                appearance = Appearance.from(payload)
                return
            }
            if channel == TerminalChannels.event {
                if let e = TerminalEvent.from(payload) { for f in terminalListeners.values { f(e) } }
                return
            }
            guard channel == Events.agentEvent, let e = AgentEvent.from(payload) else { return }
            outbox.onEvent(e)
            for f in listeners.values { f(e) }
            let next = ActivityTracker.next(activity, e)
            if next != activity { activity = next }
            // Keep the list fresh when a turn ends anywhere (another device, a task).
            switch e {
            case .done, .sessionMeta: scheduleSummaries()
            default: break
            }
        }
    }

    /// Drop the live connection (the pairing stays).
    public func disconnect() {
        generation += 1
        pump?.cancel()
        pump = nil
        summariesTask?.cancel()
        summariesTask = nil
        summariesDirty = false
        graceTask?.cancel()
        graceTask = nil
        suspended = false
        client?.close()
        client = nil
        conn = .idle
    }

    /// App came to the foreground: reconnect now rather than after the backoff,
    /// and re-read the list (chats completed or started meanwhile send no event).
    public func nudge() {
        resume()
        client?.nudge()
        nudgeFleet()
        if !pendingSignOuts.isEmpty { Task { await flushSignOuts() } }
        if conn == .online {
            scheduleSummaries()
            flushOutbox()
        }
    }

    /// The phone changed network: dial a fresh socket now.
    public func reconnect() { client?.reconnect() }

    /// The phone changed network (`path` says whether a LAN route can work):
    /// pick the route again and dial a fresh socket now.
    public func networkChanged(_ path: NetworkPath) {
        networkPath = path
        guard !suspended else { return }
        client?.networkChanged(path)
        for link in links.values where !link.suspended { link.client.networkChanged(path) }
        if !pendingSignOuts.isEmpty { Task { await flushSignOuts() } }
    }

    /// The first network the phone reports: not a move, so the socket stays
    /// unless the route it should use is another one (a LAN route on cellular).
    public func networkKnown(_ path: NetworkPath) {
        networkPath = path
        guard !suspended else { return }
        client?.setNetworkPath(path)
        for link in links.values where !link.suspended { link.client.setNetworkPath(path) }
    }

    // MARK: Background grace (TASKS.md IO-20)

    /// The app went to the background. A healthy socket is kept for `grace`
    /// seconds, so a quick app switch comes back to a live connection (and a
    /// turn finishing meanwhile still notifies); then it is closed, as iOS
    /// would suspend it anyway. One that isn't online is closed at once
    /// rather than left retrying in the background. No background mode is
    /// involved: the grace fits in the app's ordinary background time.
    public func enterBackground(grace: TimeInterval = 30) {
        graceTask?.cancel()
        guard client != nil, !suspended else { return }
        let anyOnline = conn == .online || peers.values.contains { $0.conn == .online }
        guard anyOnline, grace > 0 else { return suspend() }
        graceTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(grace * 1e9))
            guard let self, !Task.isCancelled else { return }
            self.graceTask = nil
            self.suspend()
        }
    }

    /// Close the socket now, keeping everything on screen; `resume` reopens it.
    public func suspend() {
        graceTask?.cancel()
        graceTask = nil
        suspendFleet()
        guard let c = client, !suspended else { return }
        suspended = true
        c.close()
    }

    /// Back in the foreground (or woken by a notification action): cancel a
    /// pending grace close, and reopen a suspended socket.
    public func resume() {
        graceTask?.cancel()
        graceTask = nil
        resumeFleet()
        guard suspended, let c = client else { return }
        suspended = false
        if networkPath != .unknown { c.setNetworkPath(networkPath) }
        c.connect()
    }

    // MARK: Diagnostics (TASKS.md IO-21)

    /// Check every route of the active computer: DNS, TCP, and a hello the
    /// computer answers, each timed. Never the live connection: the hello is
    /// a separate socket, closed once the relay and computer have answered.
    public func runChecks() async {
        guard !checking, let computer = active, let secret = secret(computer.id), let hostKey = secret.pinned,
              let keyBytes = E2E.fromHex(secret.keyHex) else { return }
        checking = true
        defer { checking = false }
        let routes = computer.routes
        checks = routes.map { RouteReport(url: $0) }
        var base = RelayConfig(relayUrl: computer.relayUrl, room: secret.room, key: secret.key, hostKey: hostKey, keyBytes: keyBytes,
                               deviceId: deviceId(), deviceName: deviceName(), pairCode: nil, platform: platform)
        base.helloSigner = helloSigner
        // A constant for the concurrently run probes (Swift 6 mode: a captured var is an error).
        let probe = base
        let make = makeConnection
        let name = computer.name
        for (i, url) in routes.enumerated() {
            let report = await Diagnostics.check(url, network: probeNetwork) { route in
                var config = probe
                config.relayUrl = route
                config.handshakeTimeout = 8
                return await Self.hello(await make(config), computer: name)
            }
            guard active?.id == computer.id, i < checks.count else { return }
            checks[i] = report
        }
    }

    /// One relay hello on its own socket: open, wait for the relay and the
    /// computer to answer (or 8 s), close.
    static func hello(_ c: RemoteConnection, computer: String, timeout: TimeInterval = 8) async -> ProbeStep {
        let start = Date()
        let box = HelloBox()
        let s: RelayStatus? = await withCheckedContinuation { (cont: CheckedContinuation<RelayStatus?, Never>) in
            box.cont = cont
            c.setHandlers(onStatus: { s in if s.state != .connecting { box.finish(s) } }, onEvent: nil, onWelcome: nil)
            c.connect()
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { box.finish(nil) }
        }
        c.close()
        let ms = Int((Date().timeIntervalSince(start) * 1000).rounded())
        switch s?.state {
        case .online?: return ProbeStep(ok: true, ms: ms, detail: "\(computer) answered")
        case .offline? where s?.detail == RelayStatus.badPairingKey:
            return ProbeStep(ok: false, ms: ms, detail: "Refused: \(DenyReason.badKey.rawValue)")
        case .offline?: return ProbeStep(ok: true, ms: ms, detail: "The relay answered; \(computer) isn’t connected to it")
        case .denied?: return ProbeStep(ok: false, ms: ms, detail: "Refused: \(s?.denied?.rawValue ?? "denied")")
        default: return ProbeStep(ok: false, ms: ms, detail: "No answer in \(Int(timeout)) s")
        }
    }

    /// *Share diagnostics*: the checks and the log, as text with no secrets.
    public func diagnosticsText(app: String) -> String {
        let c = active
        let log = connectionLog.text(relayHost: c?.relayHost ?? "none", route: c?.route ?? .internet)
        return Diagnostics.text(app: app, network: networkPath, routeInUse: route, reports: checks, log: log)
    }

    /// The APNs device token, registered with the relay on every connect.
    public func setPushToken(_ token: String) {
        pushToken = token
        registerPushNow()
    }

    private func registerPushNow() {
        // Every computer reached, so a chat that needs you on any of them can say so.
        for id in links.keys { registerPush(peer: id) }
        guard conn == .online, let token = pushToken, let c = client else { return }
        let kinds = pushKinds?.map(\.rawValue)
        Task { try? await c.registerPush(token: token, kinds: kinds) }
    }

    /// Register this phone's push token on one fleet link, once it is online.
    func registerPush(peer id: String) {
        guard peers[id]?.conn == .online, let token = pushToken, let c = links[id]?.client else { return }
        let kinds = pushKinds?.map(\.rawValue)
        Task { try? await c.registerPush(token: token, kinds: kinds) }
    }

    /// *Send a test notification* (IO-30): ask the computer, which asks the relay
    /// to push to this phone. Says which path it took; on `.local` the app
    /// shows the notification itself. Throws when the computer can't be reached.
    public func sendTestNotification() async throws -> TestPushResult {
        let c = try remote()
        var answered = true
        do {
            _ = try await c.call(Channels.pushTest, [], timeout: 15)
        } catch let e as RelayError where TestPushResult.unknownToComputer(e.message) {
            answered = false
        }
        return TestPushResult.decide(computerAnswered: answered, hasToken: pushToken != nil, relayDelivers: relayDelivers)
    }

    /// The last card registration: each waits for it, so the relay keeps the newest.
    private var cardRegistration: Task<Void, Never>?

    private func registerCardNow(level: Bool) {
        guard conn == .online, let c = client, let computer = active else { return }
        let (token, start, cardLevel, previous) = (cardToken, cardStartToken, cardLevel, cardRegistration)
        cardRegistration = Task {
            await previous?.value
            try? await c.registerCard(token: token, startToken: start, level: cardLevel, computerId: computer.id, computerName: computer.name)
            if level { _ = try? await c.call(Channels.cardSet, [["level": .string(cardLevel.rawValue)]], timeout: 15) }
        }
    }

    /// A chip tap (`focus`) or the close button under a finished chat (`dismiss`) on
    /// the card, so the card the computer pushes shows the same. A computer from
    /// before `card:set` refuses it; the card on this phone has it either way.
    public func cardAction(focus: String? = nil, dismiss: String? = nil) async {
        guard let c = client else { return }
        var args: [String: JSONValue] = [:]
        if let focus { args["focus"] = .string(focus) }
        if let dismiss { args["dismiss"] = .string(dismiss) }
        _ = try? await c.call(Channels.cardSet, [.object(args)], timeout: 15)
    }

    // MARK: Reading the computer

    public func refresh() async {
        guard let c = client else { return }
        summariesLoading = true
        lastError = nil
        do {
            async let summaries = c.call(Channels.sessionsSummaries)
            async let providers = c.call(Channels.providersList)
            async let settings = c.call(Channels.settingsGet)
            async let workspaces = orNil { try await c.call(Channels.workspaceList) }
            async let info = orNil { try await c.call(Channels.appInfo) }
            async let pending = orNil { try await c.call(Channels.chatPending) }
            let s = try await settings
            let r = (try await summaries, try await providers, s, await workspaces, await info, await pending)
            guard client === c else { return }
            self.summaries = SessionSummary.visible(r.0)
            self.providers = PublicProvider.list(r.1)
            // Only public projections leave this block.
            self.defaults = RemoteDefaults.from(r.2)
            self.appearance = Appearance.from(r.2)
            self.pcSettings = PcSettings.from(r.2)
            self.workspaces = WorkspaceFolder.list(r.3)
            // Approvals and questions already waiting when we (re)connect.
            for (sid, p) in PendingInput.map(r.5) where p.approval != nil || p.question != nil { activity[sid] = .needsYou }
            let appInfo = AppInfo.from(r.4)
            hostVersion = appInfo.version
            quitFromPhone = appInfo.quitFromPhone
            learnPlatform(appInfo.platform, for: activeId, name: appInfo.computerName ?? appInfo.hostname)
            // A failed read says nothing about the icon; an answer without one clears it.
            if r.4 != nil, let id = activeId { learnIcon(appInfo.machineIcon, for: id) }
            summariesLoading = false
            summariesLoaded = true
            savedListAt = nil
            saveList()
            // A chat deleted on the computer (or by another device) leaves no copy here.
            transcripts.keepOnly(Set((r.0.array ?? []).compactMap { $0.str("id") }))
        } catch {
            if client === c {
                summariesLoading = false
                summariesLoaded = true
                lastError = error.localizedDescription
            }
        }
    }

    /// Saved folders belong to the computer, not the phone's file system.
    public func addWorkspace(path: String) async throws {
        let path = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard WorkspacePath.isAbsolute(path) else { throw RelayError("Enter an absolute folder path on the computer.") }
        try await changeWorkspace(Channels.workspaceAddByPath, path)
    }

    /// Removes only the saved entry. The computer never deletes the folder on disk.
    public func removeWorkspace(_ id: String) async throws {
        try await changeWorkspace(Channels.workspaceRemove, id, refreshSummaries: true)
    }

    private func changeWorkspace(_ channel: String, _ value: String, refreshSummaries: Bool = false) async throws {
        guard conn == .online else { throw RelayError("Connect to the computer to manage folders.") }
        let c = try remote()
        let result = try await call(change: channel, [.string(value)])
        guard client === c else { return }
        workspaces = WorkspaceFolder.list(result)
        saveList()
        if refreshSummaries {
            let list = try await c.call(Channels.sessionsSummaries)
            guard client === c else { return }
            summaries = SessionSummary.visible(list)
            saveList()
        }
    }

    @discardableResult
    public func loadModels(_ providerId: String) async throws -> [ModelInfo] {
        if let m = models[providerId] { return m }
        let list = ModelInfo.list(try await remote().call(Channels.modelsList, [.string(providerId)], timeout: modelListTimeout))
        models[providerId] = list
        modelErrors[providerId] = nil
        return list
    }

    /// Every enabled provider's models, asked in parallel; a slow or failing
    /// provider is marked unreachable instead of holding up the others.
    public func loadAllModels(force: Bool = false) async {
        let enabled = providers.filter(\.enabled).map(\.id)
        if force {
            for id in enabled {
                models[id] = nil
                modelErrors[id] = nil
            }
        }
        // Children report their error; the store is written here, on the main actor.
        await withTaskGroup(of: (id: String, error: String?).self) { group in
            for id in enabled {
                group.addTask { [self] in
                    do {
                        try await self.loadModels(id)
                        return (id, nil)
                    } catch {
                        return (id, error.localizedDescription)
                    }
                }
            }
            for await (id, m) in group {
                if let m { modelErrors[id] = m.hasSuffix("timed out") ? "Didn’t answer in time." : m }
            }
        }
    }

    // MARK: The rows' pull requests

    /// Rows ask for their PRs at most this many at a time, as the desktop's sidebar does...
    public static let rowPrsBatch = 8
    /// ...and again after this long (ms), or sooner when the chat moves on or names another PR.
    public static let rowPrsFresh: Int64 = 5 * 60 * 1000

    /// The chats in `chats` whose PRs are due a lookup: they name one, and were not
    /// asked about lately with the same links, or have moved on since. Newest first.
    public func rowPrsDue(_ chats: [SessionSummary]) -> [SessionSummary] {
        let t = now()
        return chats.filter { s in
            guard !s.prUrls.isEmpty else { return false }
            guard let asked = rowPrsAsked[s.id] else { return true }
            return asked.urls != s.prUrls || s.updatedAt > asked.at || t - asked.at > Self.rowPrsFresh
        }.sorted { $0.updatedAt > $1.updatedAt }
    }

    /// Look up the state of the PRs the chats in `chats` name, on the computer each
    /// runs on, `rowPrsBatch` at a time. A failed lookup is asked again next time.
    public func loadRowPrs(_ chats: [SessionSummary]) async {
        let due = rowPrsDue(chats)
        var start = 0
        // A batch is marked asked as it goes out, so a cancelled walk leaves the rest due.
        while start < due.count, !Task.isCancelled {
            let batch = due[start..<min(start + Self.rowPrsBatch, due.count)]
            start += Self.rowPrsBatch
            let t = now()
            for s in batch { rowPrsAsked[s.id] = (s.prUrls, t) }
            let calls = batch.map { s in (s.id, try? caller(computerId(ofChat: s.id))) }
            let results = await withTaskGroup(of: (String, [PullRequest]?).self) { group in
                for (id, c) in calls {
                    group.addTask {
                        guard let c, let v = try? await c.call(Channels.prSessionList, [.string(id), .bool(false)]) else { return (id, nil) }
                        return (id, PullRequest.list(v))
                    }
                }
                var out: [(String, [PullRequest]?)] = []
                for await r in group { out.append(r) }
                return out
            }
            for (id, prs) in results {
                if let prs { rowPrs[id] = prs } else { rowPrsAsked[id] = nil }
            }
        }
    }

    // MARK: Changing chats on the computer

    // Each takes the chat's computer (`on`): nil is the active one, another is reached through its fleet link.

    /// Complete a chat (the desktop's archive): nothing is deleted.
    public func completeChat(_ sessionId: String, on computer: String? = nil) async throws {
        let at = now()
        _ = try await caller(computer).call(Channels.sessionSetOptions, [.string(sessionId), ["archivedAt": .int(at)]])
        edit(sessionId, on: computer) { $0.archived = true; $0.archivedAt = at }
    }

    public func restoreChat(_ sessionId: String, on computer: String? = nil) async throws {
        _ = try await caller(computer).call(Channels.sessionSetOptions, [.string(sessionId), ["archivedAt": nil]])
        edit(sessionId, on: computer) { $0.archived = false; $0.archivedAt = nil }
    }

    public func renameChat(_ sessionId: String, to title: String, on computer: String? = nil) async throws {
        let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        _ = try await caller(computer).call(Channels.sessionSetOptions, [.string(sessionId), ["title": .string(t)]])
        edit(sessionId, on: computer) { $0.title = t }
    }

    public func setPinned(_ sessionId: String, _ pinned: Bool, on computer: String? = nil) async throws {
        _ = try await caller(computer).call(Channels.sessionSetOptions, [.string(sessionId), ["pinned": .bool(pinned)]])
        edit(sessionId, on: computer) { $0.pinned = pinned }
    }

    public func deleteChat(_ sessionId: String, on computer: String? = nil) async throws {
        _ = try await caller(computer).call(Channels.sessionDelete, [.string(sessionId)])
        if let computer, computer != activeId {
            peers[computer]?.summaries.removeAll { $0.id == sessionId }
            peers[computer]?.activity[sessionId] = nil
            return
        }
        summaries.removeAll { $0.id == sessionId }
        transcripts.remove(sessionId)
        activity[sessionId] = nil
    }

    /// The connection a chat action (or a read, like Usage's) goes over: the active computer's, or the fleet's link to `computer`.
    func caller(_ computer: String?) throws -> RemoteConnection {
        guard let computer, computer != activeId else { return try remote() }
        guard peers[computer]?.conn == .online, let c = links[computer]?.client else {
            let name = computers.first { $0.id == computer }?.name ?? "That computer"
            throw RelayError("\(name) isn’t connected right now. This phone keeps trying.")
        }
        return c
    }

    /// Change a chat's row where the list keeps it.
    private func edit(_ sessionId: String, on computer: String?, _ change: (inout SessionSummary) -> Void) {
        if let computer, computer != activeId {
            guard let i = peers[computer]?.summaries.firstIndex(where: { $0.id == sessionId }) else { return }
            change(&peers[computer]!.summaries[i])
        } else if let i = summaries.firstIndex(where: { $0.id == sessionId }) {
            change(&summaries[i])
        }
    }

    /// Start a chat on the computer with a model, a folder and a tool policy.
    public func createChat(providerId: String, modelId: String, workspaceId: String?, mode: PcSettings.ChatMode?, effort: Effort? = nil, supportingWorkspaceIds: [String] = []) async throws -> String {
        let r = try remote()
        let created = try await r.call(Channels.sessionCreate, workspaceId.map { [.string($0)] } ?? [])
        guard let session = Session.from(created) else { throw RelayError("Your computer didn’t create the chat.") }
        var options: [String: JSONValue] = ["providerId": .string(providerId), "modelId": .string(modelId)]
        if let mode { options["mode"] = .string(mode.rawValue) }
        if let effort { options["effort"] = .string(effort.rawValue) }
        do {
            guard client === r else { throw RelayError("The selected computer changed. Open the new chat on its original computer.", fromComputer: true) }
            // A mode above the computer's default needs Face ID (`call(raising:)`).
            _ = try await call(raising: Channels.sessionSetOptions, [.string(session.id), .object(options)])
            guard client === r else { throw RelayError("The selected computer changed. Open the new chat on its original computer.", fromComputer: true) }
            if !supportingWorkspaceIds.isEmpty {
                _ = try await call(change: Channels.sessionSetSupportingWorkspaces,
                                   [.string(session.id), .array(supportingWorkspaceIds.map(JSONValue.string))])
            }
        } catch {
            // The chat exists either way: show it, then say why its options didn't stick.
            scheduleSummaries()
            throw error
        }
        scheduleSummaries()
        return session.id
    }

    /// Re-read the chat list soon (a chat was made or changed from here).
    public func reloadList() { scheduleSummaries() }

    /// Change the computer's phone-settable settings; the reply is what was saved there.
    /// Raising `defaultChatMode` needs Face ID (`call(raising:)`).
    public func updatePcSettings(_ patch: JSONValue) async throws {
        let c = try remote()
        let saved = try await call(raising: Channels.settingsUpdate, [patch])
        guard client === c else { return }
        pcSettings = PcSettings.from(saved)
    }

    /// The star changes future chats on this computer, not the current chat's folder.
    public func setDefaultWorkspace(_ id: String, included: Bool) async throws {
        guard conn == .online, workspaces.contains(where: { $0.id == id }) else {
            throw RelayError("Connect to the computer and choose a saved folder.")
        }
        let valid = Set(workspaces.map(\.id))
        var ids = pcSettings.defaultWorkspaceIds.filter { valid.contains($0) && $0 != id }
        if included { ids.append(id) }
        try await updatePcSettings(["defaultWorkspaceIds": .array(ids.map(JSONValue.string))])
    }

    /// Set the active computer's icon, there, so every device shows the same one: a name from `computerIcons`, or "" for none.
    public func setMachineIcon(_ name: String) async throws {
        guard let id = activeId else { return }
        try await updatePcSettings(PcSettings.patch(icon: name))
        learnIcon(name.isEmpty ? nil : name, for: id)
    }

    // MARK: Internals

    private func clearComputerState() {
        savedListAt = nil
        summariesLoaded = false
        summaries = []
        providers = []
        models = [:]
        modelErrors = [:]
        workspaces = []
        activity = [:]
        // Another computer, or the same one later: its settings are unknown until it answers.
        pcSettings = PcSettings()
        hostVersion = nil
        hostProtocol = nil
        relayDelivers = nil
        quitFromPhone = false
        lastError = nil
    }

    private func scheduleSummaries() {
        guard let c = client else { return }
        summariesDirty = true
        guard summariesTask == nil else { return }
        let delay = summariesDebounce
        let gen = generation
        summariesTask = Task { @MainActor [weak self] in
            guard let self else { return }
            defer {
                if self.generation == gen { self.summariesTask = nil }
            }
            repeat {
                try? await Task.sleep(nanoseconds: UInt64(delay * 1e9))
                guard self.client === c, !Task.isCancelled else { return }
                // Notifications during the debounce are covered by this call.
                self.summariesDirty = false
                let list = try? await c.call(Channels.sessionsSummaries)
                guard self.client === c, !Task.isCancelled else { return }
                if let list {
                    self.summaries = SessionSummary.visible(list)
                    self.saveList()
                }
                // Only a new invalidation retries, never a failed call alone.
            } while self.summariesDirty
        }
    }

    /// The live list, as the phone's saved copy (only when the user keeps one).
    private func saveList() {
        guard let cache = chatListCache, let id = activeId, summariesLoaded, savedListAt == nil else { return }
        cache.save(id, SavedChatList(savedAt: now(), summaries: summaries, folders: workspaces))
    }

    func learnPlatform(_ platform: String?, for id: String?, name: String? = nil) {
        guard let id, let i = computers.firstIndex(where: { $0.id == id }) else { return }
        let old = computers[i]
        let generic = [defaultComputerName, "Mac", "Windows PC", "Linux PC"].contains(old.name)
        let custom = old.nameIsCustom ?? !generic
        let reported = name?.trimmingCharacters(in: .whitespacesAndNewlines)
        if !custom {
            computers[i].name = reported.flatMap { $0.isEmpty ? nil : String($0.prefix(40)) } ?? (generic ? osName(platform ?? old.platform) : old.name)
        }
        computers[i].nameIsCustom = custom
        if let platform { computers[i].platform = platform }
        if computers[i] != old { saveIndex() }
    }

    func learnIcon(_ icon: String?, for id: String) {
        guard let i = computers.firstIndex(where: { $0.id == id }), computers[i].icon != icon else { return }
        computers[i].icon = icon
        saveIndex()
    }

    func dropPairCode(_ id: String) {
        guard var s = secret(id), s.pair != nil else { return }
        s.pair = nil
        saveSecret(id, s)
    }

    func deviceId() -> String {
        if let id = store.get(Self.deviceKey) { return id }
        let id = newId()
        store.set(Self.deviceKey, id)
        return id
    }

    func secret(_ id: String) -> ComputerSecret? {
        store.get(Self.secretKey(id)).flatMap { try? JSONDecoder().decode(ComputerSecret.self, from: Data($0.utf8)) }
    }

    private func saveSecret(_ id: String, _ s: ComputerSecret) {
        let data = (try? JSONEncoder().encode(s)).map { String(decoding: $0, as: UTF8.self) }
        store.set(Self.secretKey(id), data)
    }

    private func decodeIndex() -> [Computer] {
        store.get(Self.indexKey).flatMap { try? JSONDecoder().decode([Computer].self, from: Data($0.utf8)) } ?? []
    }

    private func saveIndex() {
        let data = (try? JSONEncoder().encode(computers)).map { String(decoding: $0, as: UTF8.self) }
        store.set(Self.indexKey, data)
    }
}

#if DEBUG
extension ComputersStore {
    /// UI-test fixtures only (`-uiTestModelTabs`): providers and their model lists as a
    /// computer would send them (`providers:list`, `models:list`), with no connection.
    public func seedModelsForUITest(providers: JSONValue, models: [String: JSONValue]) {
        self.providers = PublicProvider.list(providers)
        self.models = models.mapValues { ModelInfo.list($0) }
        modelErrors = [:]
    }
}
#endif

func orNil<T: Sendable>(_ body: @Sendable () async throws -> T) async -> T? {
    try? await body()
}

/// Hands the first settled status of a hello probe to its waiter, once.
private final class HelloBox: @unchecked Sendable {
    private let lock = NSLock()
    var cont: CheckedContinuation<RelayStatus?, Never>?

    func finish(_ s: RelayStatus?) {
        lock.lock()
        let c = cont
        cont = nil
        lock.unlock()
        c?.resume(returning: s)
    }
}

#if DEBUG
extension ComputersStore {
    /// In-memory native UI evidence only. No secret, client, pairing or persistence is created.
    public func seedParityFixture(step: Int = 0) {
        computers = [Computer(id: "parity-fixture", name: "Fixture Mac", relayUrl: "ws://127.0.0.1:1", pairedAt: 0)]
        activeId = "parity-fixture"
        conn = .online
        summariesLoading = false
        summariesLoaded = true
        workspaces = [WorkspaceFolder(id: "app", name: "App", path: "/Projects/App"), WorkspaceFolder(id: "docs", name: "Docs", path: "/Projects/Docs")]
        pcSettings = PcSettings.from(["defaultWorkspaceIds": ["app"], "effort": "medium"])
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        summaries = SessionSummary.visible([
            ["id": "draft", "title": "A new idea", "exchangeCount": 0, "updatedAt": .int(now)],
            ["id": "moving", "title": "iPhone parity", "exchangeCount": 2, "updatedAt": .int(now),
             "phase": step == 0 ? "building" : "verifying", "activeRun": step < 2 ? [:] : .null,
             "activeWatchCount": step == 2 ? 1 : 0],
            ["id": "input", "title": "Choose the release", "exchangeCount": 1, "updatedAt": .int(now)],
            ["id": "done", "title": "Finished review", "exchangeCount": 1, "updatedAt": .int(now)]
        ])
        activity = ["input": .needsYou]
        if step < 2 { activity["moving"] = .running }
    }
}
#endif
